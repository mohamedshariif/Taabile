import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Location, MemberDetail, PermissionCatalog, Role } from '../../api/types';
import { useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, Check, ErrorText, Muted, PageTitle, SectionTitle, Select } from '../../components/ui';

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'];
const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Admin', MANAGER: 'Manager', STAFF: 'Staff', VIEWER: 'Viewer' };
const needsLocations = (r: Role) => r === 'MANAGER' || r === 'STAFF';

export function UserDetailPage() {
  const { userId = '' } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const isSelf = userId === me.user.id;

  const catalog = useQuery({ queryKey: ['catalog'], queryFn: () => api<PermissionCatalog>('/users/catalog'), staleTime: Infinity });
  const detail = useQuery({ queryKey: ['member', userId], queryFn: () => api<MemberDetail>(`/users/${userId}`) });
  const locations = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/locations') });

  const [role, setRole] = useState<Role>('STAFF');
  const [locIds, setLocIds] = useState<string[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [revoked, setRevoked] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  // Copy the server's data into the form whenever it arrives (or changes after a save).
  const member = detail.data?.member;
  useEffect(() => {
    if (!member) return;
    setRole(member.role);
    setLocIds(member.locationIds);
    setExtra(member.extraPermissions);
    setRevoked(member.revokedPermissions);
  }, [member]);

  const preset = catalog.data?.rolePresets[role] ?? {};
  const isOn = (p: string) => (p in preset ? !revoked.includes(p) : extra.includes(p));

  const flip = (p: string) => {
    setSaved(false);
    if (p in preset) setRevoked((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p]));
    else setExtra((e) => (e.includes(p) ? e.filter((x) => x !== p) : [...e, p]));
  };

  const changeRole = (r: Role) => {
    setSaved(false);
    setRole(r);
    // A new role starts from that role's own permissions, with no individual switches.
    setExtra([]);
    setRevoked([]);
    if (!needsLocations(r)) setLocIds([]);
  };

  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const p of catalog.data?.permissions ?? []) {
      const g = p.split('.')[0] ?? 'other';
      out.set(g, [...(out.get(g) ?? []), p]);
    }
    return [...out.entries()];
  }, [catalog.data]);

  const save = useMutation({
    mutationFn: () =>
      api<MemberDetail>(`/users/${userId}`, {
        method: 'PATCH',
        body: { role, locationIds: needsLocations(role) ? locIds : [], extraPermissions: extra, revokedPermissions: revoked },
      }),
    onSuccess: (d) => {
      qc.setQueryData(['member', userId], d);
      void qc.invalidateQueries({ queryKey: ['members'] });
      setSaved(true);
    },
  });
  const setStatus = useMutation({
    // This endpoint answers with just { member }, so we reload the full detail (with permissions) afterwards.
    mutationFn: (to: 'deactivate' | 'reactivate') => api(`/users/${userId}/${to}`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['member', userId] });
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });

    if (detail.isLoading || catalog.isLoading) return <Muted>Loading…</Muted>;
  if (detail.isError || !detail.data || !member) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;

  const active = member.status === 'ACTIVE';
  const activeLocs = (locations.data?.locations ?? []).filter((l) => l.status === 'ACTIVE' || locIds.includes(l.id));
  const effectiveCount = Object.keys(detail.data.permissions).length;

  return (
    <>
      <p className="mb-2"><Link to="/users">← All users</Link></p>
      <PageTitle>{member.name}</PageTitle>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <span className="break-all">{member.email}</span> · <Badge tone={active ? 'ok' : 'off'}>{active ? 'Active' : 'Deactivated'}</Badge> · has {effectiveCount} permissions today
      </p>

      {isSelf && <Card>This is your own account. For safety you cannot change your own role or permissions, or deactivate yourself. Ask another Admin.</Card>}

      <Card as="fieldset" disabled={isSelf || save.isPending}>
        <SectionTitle first>Role</SectionTitle>
        <Select value={role} onChange={(e) => changeRole(e.target.value as Role)} aria-label="Role" className="max-w-xs">
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
        <Muted small className="mt-1">Changing the role resets the individual switches below to that role's defaults.</Muted>

        {needsLocations(role) && (
          <>
            <SectionTitle>Locations</SectionTitle>
            {activeLocs.map((l) => (
              <Check
                key={l.id}
                label={<>{l.name} <span className="text-sm font-normal text-muted">({l.type === 'STORE' ? 'store' : 'warehouse'})</span></>}
                checked={locIds.includes(l.id)}
                onChange={() => { setSaved(false); setLocIds((x) => (x.includes(l.id) ? x.filter((i) => i !== l.id) : [...x, l.id])); }}
              />
            ))}
            {locIds.length === 0 && <p className="my-1 text-sm text-danger">No location chosen: this person cannot work anywhere yet.</p>}
          </>
        )}

        <SectionTitle>Permissions</SectionTitle>
        <Muted small>
          Switches follow the role. Turn one on or off for just this person; a changed switch is marked <em>custom</em>.
        </Muted>
        <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
          {groups.map(([group, perms]) => (
            <div key={group} className="mb-3 min-w-0">
              <h3 className="mt-2 text-sm font-semibold tracking-wide text-muted uppercase">{group}</h3>
              {perms.map((p) => {
                const custom = p in preset ? revoked.includes(p) : extra.includes(p);
                return (
                  <Check
                    key={p}
                    label={<><code className="break-all">{p}</code>{custom && <Badge tone="wait">custom</Badge>}</>}
                    checked={isOn(p)}
                    onChange={() => flip(p)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button onClick={() => { setSaved(false); save.mutate(); }} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          {saved && <span className="font-medium text-brand">Saved. It applies on their very next request.</span>}
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>

      {!isSelf && (
        <Card>
          <SectionTitle first>{active ? 'Deactivate' : 'Reactivate'}</SectionTitle>
          <Muted small className="mb-3">
            {active
              ? 'They are signed out everywhere and cannot sign in again. Their history stays. Users are never deleted.'
              : 'They will be able to sign in again with their existing password.'}
          </Muted>
          <Button
            variant={active ? 'danger' : 'primary'}
            disabled={setStatus.isPending}
            onClick={() => {
              if (!active || window.confirm(`Deactivate ${member.name}? They will be signed out immediately.`)) {
                setStatus.mutate(active ? 'deactivate' : 'reactivate');
              }
            }}
          >
            {active ? 'Deactivate user' : 'Reactivate user'}
          </Button>
          {setStatus.isError && <ErrorText>{errorMessage(setStatus.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}