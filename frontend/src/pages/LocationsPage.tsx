import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import type { Location, LocationType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select, type Column } from '../components/ui';

// Everybody in the company may SEE the locations (other screens need them).
// Only people with company.manage see the add / rename / switch-off controls.
// The server enforces this too; hiding the controls is just a tidier screen.
export function LocationsPage() {
  const { can } = useAuth();
  const canManage = can('company.manage');
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['locations'] });

  const list = useQuery({ queryKey: ['locations'], queryFn: () => api<{ locations: Location[] }>('/locations') });

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState<LocationType>('STORE');
  // Which row is being renamed, and the text typed so far.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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

  const columns: Column<Location>[] = [
    {
      header: 'Name',
      primary: true,
      cell: (l) =>
        editingId === l.id ? (
          <Input className="mt-0!" aria-label="New name" value={draft} minLength={2} maxLength={80} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          l.name
        ),
    },
    { header: 'Code', cell: (l) => <code>{l.code}</code> },
    { header: 'Type', cell: (l) => (l.type === 'STORE' ? 'Store' : 'Warehouse') },
    { header: 'Status', cell: (l) => <Badge tone={l.status === 'ACTIVE' ? 'ok' : 'off'}>{l.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge> },
  ];
  if (canManage) {
    columns.push({
      header: '',
      actions: true,
      cell: (l) =>
        editingId === l.id ? (
          <>
            <Button
              small
              disabled={update.isPending || draft.trim().length < 2}
              onClick={() => {
                update.mutate({ id: l.id, name: draft.trim() });
                setEditingId(null);
              }}
            >
              Save
            </Button>
            <Button small variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button small variant="ghost" onClick={() => { setEditingId(l.id); setDraft(l.name); }}>Rename</Button>
            <Button small variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: l.id, status: l.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>
              {l.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
            </Button>
          </>
        ),
    });
  }

  return (
    <>
      <PageTitle>Locations</PageTitle>
      <Muted>Your stores and warehouses. The code is printed on documents and cannot be changed later.</Muted>

      {list.isLoading && <Muted className="mt-3">Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && (
        <DataTable rows={list.data.locations} columns={columns} rowKey={(l) => l.id} dim={(l) => l.status !== 'ACTIVE'} empty="No locations yet." />
      )}
      {update.isError && <ErrorText>{errorMessage(update.error)}</ErrorText>}

      {canManage && (
        <Card as="form" onSubmit={submit}>
          <SectionTitle first>Add a location</SectionTitle>
          <FieldRow>
            <Field label="Name">
              <Input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Main store" />
            </Field>
            <Field label="Code">
              <Input required maxLength={12} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="A" />
            </Field>
            <Field label="Type">
              <Select value={type} onChange={(e) => setType(e.target.value as LocationType)}>
                <option value="STORE">Store</option>
                <option value="WAREHOUSE">Warehouse</option>
              </Select>
            </Field>
          </FieldRow>
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add location'}</Button>
          {create.isError && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}