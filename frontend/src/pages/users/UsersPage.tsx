import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Invitation, InvitationResult, Location, Member, Role } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, Check, DataTable, ErrorText, Field, FieldRow, Group, Input, Muted, PageTitle, SectionTitle, Select, type Column } from '../../components/ui';

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Admin', MANAGER: 'Manager', STAFF: 'Staff', VIEWER: 'Viewer' };
const needsLocations = (r: Role) => r === 'MANAGER' || r === 'STAFF';

export function UsersPage() {
  const me = useMe();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ members: Member[] }>('/users') });
  const invites = useQuery({ queryKey: ['invitations'], queryFn: () => api<{ invitations: Invitation[] }>('/invitations') });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/locations') });
  const refreshInvites = () => qc.invalidateQueries({ queryKey: ['invitations'] });

  // The link of the most recently created / resent invitation (development only).
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('STAFF');
  const [picked, setPicked] = useState<string[]>([]);

  const activeLocations = (locations.data?.locations ?? []).filter((l) => l.status === 'ACTIVE');
  const nameOf = (id: string) => locations.data?.locations.find((l) => l.id === id)?.name ?? '—';
  const roles: Role[] = me.role === 'ADMIN' ? ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'] : ['MANAGER', 'STAFF', 'VIEWER'];

  const show = (r: InvitationResult, wording: string) => {
    setLink(r.devLink ? { email: r.invitation.email, url: r.devLink } : null);
    setNotice(r.devLink ? null : `${wording} ${r.invitation.email}.`);
  };

  const invite = useMutation({
    mutationFn: () =>
      api<InvitationResult>('/invitations', {
        method: 'POST',
        body: { email, role, locationIds: needsLocations(role) ? picked : [] },
      }),
    onSuccess: (r) => {
      show(r, 'Invitation emailed to');
      setEmail('');
      setPicked([]);
      void refreshInvites();
    },
  });
  const resend = useMutation({
    mutationFn: (id: string) => api<InvitationResult>(`/invitations/${id}/resend`, { method: 'POST' }),
    onSuccess: (r) => {
      show(r, 'A new invitation was emailed to');
      void refreshInvites();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/invitations/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => void refreshInvites(),
  });

    const submit = (e: FormEvent) => {
    e.preventDefault();
    setLink(null);
    setNotice(null);
    invite.mutate();
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const memberColumns: Column<Member>[] = [
    {
      header: 'Name',
      primary: true,
      cell: (m) => (
        <>
          {m.name}
          <div className="text-sm font-normal text-muted">{m.email}</div>
        </>
      ),
    },
    { header: 'Role', cell: (m) => ROLE_LABEL[m.role] },
    {
      header: 'Locations',
      cell: (m) =>
        needsLocations(m.role) ? (m.locationIds.length ? m.locationIds.map(nameOf).join(', ') : <span className="text-danger">none</span>) : 'All',
    },
    { header: 'Status', cell: (m) => <Badge tone={m.status === 'ACTIVE' ? 'ok' : 'off'}>{m.status === 'ACTIVE' ? 'Active' : 'Deactivated'}</Badge> },
    { header: 'Last sign-in', cell: (m) => (m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never') },
    { header: '', actions: true, cell: (m) => <Link to={`/users/${m.userId}`}>{m.userId === me.user.id ? 'View' : 'Manage'}</Link> },
  ];

  const inviteColumns: Column<Invitation>[] = [
    { header: 'Email', primary: true, cell: (i) => i.email },
    { header: 'Role', cell: (i) => ROLE_LABEL[i.role] },
    { header: 'Status', cell: (i) => <Badge tone={i.status === 'PENDING' ? 'wait' : i.status === 'ACCEPTED' ? 'ok' : 'off'}>{i.status.toLowerCase()}</Badge> },
    { header: 'Expires', cell: (i) => new Date(i.expiresAt).toLocaleString() },
    {
      header: '',
      actions: true,
      cell: (i) => (
        <>
          {(i.status === 'PENDING' || i.status === 'EXPIRED') && (
            <Button small variant="ghost" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}>Send again</Button>
          )}
          {i.status === 'PENDING' && (
            <Button small variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Cancel</Button>
          )}
        </>
      ),
    },
  ];

  return (
    <>
      <PageTitle>Users</PageTitle>

      <SectionTitle>People in {me.company.name}</SectionTitle>
      {members.isLoading && <Muted>Loading…</Muted>}
      {members.isError && <ErrorText>{errorMessage(members.error)}</ErrorText>}
      {members.data && <DataTable rows={members.data.members} columns={memberColumns} rowKey={(m) => m.userId} dim={(m) => m.status !== 'ACTIVE'} />}

      <Card as="form" onSubmit={submit}>
        <SectionTitle first>Invite someone</SectionTitle>
        <FieldRow>
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          </Field>
        </FieldRow>
        {needsLocations(role) && (
          <Group legend="Where will they work?">
            {activeLocations.length === 0 && <Muted small>Add a location first (Locations menu).</Muted>}
            {activeLocations.map((l) => (
              <Check key={l.id} label={l.name} checked={picked.includes(l.id)} onChange={() => toggle(l.id)} />
            ))}
            {picked.length === 0 && activeLocations.length > 0 && (
              <p className="my-1 text-sm text-danger">A {ROLE_LABEL[role]} with no location cannot work anywhere yet. Choose at least one.</p>
            )}
          </Group>
        )}
        <Button type="submit" disabled={invite.isPending}>{invite.isPending ? 'Sending…' : 'Send invitation'}</Button>
        <Muted small className="mt-2">The link works once and expires after 72 hours. They choose their own password; you never see it.</Muted>
        {invite.isError && <ErrorText>{errorMessage(invite.error)}</ErrorText>}
      </Card>

      {link && <DevLink email={link.email} url={link.url} />}
      {notice && <Card role="status">{notice}</Card>}

      <SectionTitle>Invitations</SectionTitle>
      {invites.data && <DataTable rows={invites.data.invitations} columns={inviteColumns} rowKey={(i) => i.id} empty="No invitations yet." />}
      {(resend.isError || revoke.isError) && <ErrorText>{errorMessage(resend.error ?? revoke.error)}</ErrorText>}
    </>
  );
}

function DevLink({ email, url }: { email: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card role="status" className="border-warn">
      <strong>Development mode:</strong> no real email is sent yet. Give this one-time link to {email}:
      <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <Button
        small
        className="mt-2"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </Card>
  );
}