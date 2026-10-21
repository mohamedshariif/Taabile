import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import type { Location, LocationType } from '../api/types';
import { useAuth } from '../auth/AuthContext';

export function LocationsPage() {
  const { can } = useAuth();
  const canManage = can('company.manage');
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['locations'] });

  const list = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/locations') });

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState<LocationType>('STORE');

  const create = useMutation({
    mutationFn: () => api('/locations', { method: 'POST', body: { name, code, type } }),
    onSuccess: () => {
      setName('');
      setCode('');
      void refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; status?: 'ACTIVE' | 'INACTIVE' }) =>
      api(`/locations/${v.id}`, { method: 'PATCH', body: { ...(v.name ? { name: v.name } : {}), ...(v.status ? { status: v.status } : {}) } }),
    onSuccess: () => void refresh(),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <>
      <h1>Locations</h1>
      <p className="muted">Your stores and warehouses. The code is printed on documents and cannot be changed later.</p>

      {list.isLoading && <p className="muted">Loading…</p>}
      {list.isError && <p className="error">{errorMessage(list.error)}</p>}

      {list.data && (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Type</th>
              <th>Status</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {list.data.locations.map((l) => (
              <LocationRow key={l.id} loc={l} canManage={canManage} busy={update.isPending} onChange={(v) => update.mutate({ id: l.id, ...v })} />
            ))}
            {list.data.locations.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">No locations yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {update.isError && <p className="error" role="alert">{errorMessage(update.error)}</p>}

      {canManage && (
        <form className="card" onSubmit={submit}>
          <h2>Add a location</h2>
          <div className="row">
            <label>
              Name
              <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Main store" />
            </label>
            <label>
              Code
              <input required maxLength={12} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="A" />
            </label>
            <label>
              Type
              <select value={type} onChange={(e) => setType(e.target.value as LocationType)}>
                <option value="STORE">Store</option>
                <option value="WAREHOUSE">Warehouse</option>
              </select>
            </label>
          </div>
          <button disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add location'}</button>
          {create.isError && <p className="error" role="alert">{errorMessage(create.error)}</p>}
        </form>
      )}
    </>
  );
}

function LocationRow(props: {
  loc: Location;
  canManage: boolean;
  busy: boolean;
  onChange: (v: { name?: string; status?: 'ACTIVE' | 'INACTIVE' }) => void;
}) {
  const { loc, canManage, busy, onChange } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(loc.name);
  const active = loc.status === 'ACTIVE';

  return (
    <tr className={active ? '' : 'dim'}>
      <td>
        {editing ? (
          <input value={draft} minLength={2} maxLength={80} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          loc.name
        )}
      </td>
      <td><code>{loc.code}</code></td>
      <td>{loc.type === 'STORE' ? 'Store' : 'Warehouse'}</td>
      <td><span className={`badge ${active ? 'ok' : 'off'}`}>{active ? 'Active' : 'Inactive'}</span></td>
      {canManage && (
        <td className="actions">
          {editing ? (
            <>
              <button
                className="small"
                disabled={busy || draft.trim().length < 2}
                onClick={() => {
                  onChange({ name: draft.trim() });
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button className="small ghost" onClick={() => { setEditing(false); setDraft(loc.name); }}>Cancel</button>
            </>
          ) : (
            <>
              <button className="small ghost" onClick={() => setEditing(true)}>Rename</button>
              <button className="small ghost" disabled={busy} onClick={() => onChange({ status: active ? 'INACTIVE' : 'ACTIVE' })}>
                {active ? 'Switch off' : 'Switch on'}
              </button>
            </>
          )}
        </td>
      )}
    </tr>
  );
}