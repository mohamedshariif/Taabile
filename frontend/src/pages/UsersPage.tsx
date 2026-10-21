import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { Invitation, InvitationResult, Location, Member, Role } from '../api/types';
import { useMe } from '../auth/AuthContext';

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

  return (
    <>
      <h1>Users</h1>

      <h2>People in {me.company.name}</h2>
      {members.isLoading && <p className="muted">Loading…</p>}
      {members.isError && <p className="error">{errorMessage(members.error)}</p>}
      {members.data && (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Locations</th><th>Status</th><th>Last sign-in</th><th></th></tr>
          </thead>
          <tbody>
            {members.data.members.map((m) => (
              <tr key={m.userId} className={m.status === 'ACTIVE' ? '' : 'dim'}>
                <td>
                  {m.name}
                  <div className="muted small">{m.email}</div>
                </td>
                <td>{ROLE_LABEL[m.role]}</td>
                <td className="small">
                  {needsLocations(m.role) ? (m.locationIds.length ? m.locationIds.map(nameOf).join(', ') : <span className="error">none</span>) : 'All'}
                </td>
                <td><span className={`badge ${m.status === 'ACTIVE' ? 'ok' : 'off'}`}>{m.status === 'ACTIVE' ? 'Active' : 'Deactivated'}</span></td>
                <td className="small">{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'Never'}</td>
                <td><Link to={`/users/${m.userId}`}>{m.userId === me.user.id ? 'View' : 'Manage'}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="card" onSubmit={submit}>
        <h2>Invite someone</h2>
        <div className="row">
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
        </div>
        {needsLocations(role) && (
          <fieldset>
            <legend>Where will they work?</legend>
            {activeLocations.length === 0 && <p className="muted small">Add a location first (Locations menu).</p>}
            {activeLocations.map((l) => (
              <label key={l.id} className="check">
                <input type="checkbox" checked={picked.includes(l.id)} onChange={() => toggle(l.id)} /> {l.name}
              </label>
            ))}
            {picked.length === 0 && activeLocations.length > 0 && (
              <p className="small error">A {ROLE_LABEL[role]} with no location cannot work anywhere yet. Choose at least one.</p>
            )}
          </fieldset>
        )}
        <button disabled={invite.isPending}>{invite.isPending ? 'Sending…' : 'Send invitation'}</button>
        <p className="muted small">The link works once and expires after 72 hours. They choose their own password; you never see it.</p>
        {invite.isError && <p className="error" role="alert">{errorMessage(invite.error)}</p>}
      </form>

      {link && <DevLink email={link.email} url={link.url} />}
      {notice && <p className="card" role="status">{notice}</p>}

      <h2>Invitations</h2>
      {invites.data && (
        <table className="table">
          <thead>
            <tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr>
          </thead>
          <tbody>
            {invites.data.invitations.map((i) => (
              <tr key={i.id}>
                <td>{i.email}</td>
                <td>{ROLE_LABEL[i.role]}</td>
                <td><span className={`badge ${i.status === 'PENDING' ? 'wait' : i.status === 'ACCEPTED' ? 'ok' : 'off'}`}>{i.status.toLowerCase()}</span></td>
                <td className="small">{new Date(i.expiresAt).toLocaleString()}</td>
                <td className="actions">
                  {(i.status === 'PENDING' || i.status === 'EXPIRED') && (
                    <button className="small ghost" disabled={resend.isPending} onClick={() => resend.mutate(i.id)}>Send again</button>
                  )}
                  {i.status === 'PENDING' && (
                    <button className="small ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
            {invites.data.invitations.length === 0 && <tr><td colSpan={5} className="muted">No invitations yet.</td></tr>}
          </tbody>
        </table>
      )}
      {(resend.isError || revoke.isError) && <p className="error" role="alert">{errorMessage(resend.error ?? revoke.error)}</p>}
    </>
  );
}

function DevLink({ email, url }: { email: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card devlink" role="status">
      <strong>Development mode:</strong> no real email is sent yet. Give this one-time link to {email}:
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="small"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}