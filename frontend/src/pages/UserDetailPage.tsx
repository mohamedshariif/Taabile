import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import type { Location, MemberDetail, PermissionCatalog, Role } from '../api/types';
import { useMe } from '../auth/AuthContext';

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

  if (detail.isLoading || catalog.isLoading) return <p className="muted">Loading…</p>;
  if (detail.isError || !detail.data || !member) return <p className="error">{errorMessage(detail.error)}</p>;

  const active = member.status === 'ACTIVE';
  const activeLocs = (locations.data?.locations ?? []).filter((l) => l.status === 'ACTIVE' || locIds.includes(l.id));
  const effectiveCount = Object.keys(detail.data.permissions).length;

  return (
    <>
      <p><Link to="/users">← All users</Link></p>
      <h1>{member.name}</h1>
      <p className="muted">
        {member.email} · <span className={`badge ${active ? 'ok' : 'off'}`}>{active ? 'Active' : 'Deactivated'}</span> · has {effectiveCount} permissions today
      </p>

      {isSelf && <p className="card">This is your own account. For safety you cannot change your own role or permissions, or deactivate yourself. Ask another Admin.</p>}

      <fieldset className="card" disabled={isSelf || save.isPending}>
        <h2>Role</h2>
        <select value={role} onChange={(e) => changeRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <p className="muted small">Changing the role resets the individual switches below to that role's defaults.</p>

        {needsLocations(role) && (
          <>
            <h2>Locations</h2>
            {activeLocs.map((l) => (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={locIds.includes(l.id)}
                  onChange={() => { setSaved(false); setLocIds((x) => (x.includes(l.id) ? x.filter((i) => i !== l.id) : [...x, l.id])); }}
                />{' '}
                {l.name} <span className="muted small">({l.type === 'STORE' ? 'store' : 'warehouse'})</span>
              </label>
            ))}
            {locIds.length === 0 && <p className="small error">No location chosen: this person cannot work anywhere yet.</p>}
          </>
        )}

        <h2>Permissions</h2>
        <p className="muted small">
          Switches follow the role. Turn one on or off for just this person; a changed switch is marked <em>custom</em>.
        </p>
        {groups.map(([group, perms]) => (
          <div key={group} className="permgroup">
            <h3>{group}</h3>
            {perms.map((p) => {
              const custom = p in preset ? revoked.includes(p) : extra.includes(p);
              return (
                <label key={p} className="switch">
                  <input type="checkbox" checked={isOn(p)} onChange={() => flip(p)} />
                  <code>{p}</code>
                  {custom && <span className="badge wait">custom</span>}
                </label>
              );
            })}
          </div>
        ))}

        <button type="button" onClick={() => { setSaved(false); save.mutate(); }} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span className="ok-text"> Saved. It applies on their very next request.</span>}
        {save.isError && <p className="error" role="alert">{errorMessage(save.error)}</p>}
      </fieldset>

      {!isSelf && (
        <div className="card">
          <h2>{active ? 'Deactivate' : 'Reactivate'}</h2>
          <p className="muted small">
            {active
              ? 'They are signed out everywhere and cannot sign in again. Their history stays. Users are never deleted.'
              : 'They will be able to sign in again with their existing password.'}
          </p>
          <button
            className={active ? 'danger' : ''}
            disabled={setStatus.isPending}
            onClick={() => {
              if (!active || window.confirm(`Deactivate ${member.name}? They will be signed out immediately.`)) {
                setStatus.mutate(active ? 'deactivate' : 'reactivate');
              }
            }}
          >
            {active ? 'Deactivate user' : 'Reactivate user'}
          </button>
          {setStatus.isError && <p className="error" role="alert">{errorMessage(setStatus.error)}</p>}
        </div>
      )}
    </>
  );
}