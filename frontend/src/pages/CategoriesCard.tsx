import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import type { Category } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, SectionTitle, type Column } from '../components/ui';

// A flat list of categories. Everyone who can see products sees them; people with products.manage can add,
// rename and switch them off. Only the Admin can delete one, and only while no product uses it.
export function CategoriesCard() {
  const { can } = useAuth();
  const canManage = can('products.manage');
  const canDelete = can('records.delete');
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['categories'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };

  const list = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/categories') });
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const create = useMutation({
    mutationFn: () => api('/categories', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; status?: 'ACTIVE' | 'INACTIVE' }) =>
      api(`/categories/${v.id}`, { method: 'PATCH', body: { ...(v.name ? { name: v.name } : {}), ...(v.status ? { status: v.status } : {}) } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/categories/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const columns: Column<Category>[] = [
    {
      header: 'Category',
      primary: true,
      cell: (c) =>
        editingId === c.id ? (
          <Input className="mt-0!" aria-label="New name" value={draft} minLength={2} maxLength={60} onChange={(e) => setDraft(e.target.value)} />
        ) : (
          c.name
        ),
    },
    { header: 'Products', cell: (c) => c.productCount },
    { header: 'Status', cell: (c) => <Badge tone={c.status === 'ACTIVE' ? 'ok' : 'off'}>{c.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
  ];
  if (canManage) {
    columns.push({
      header: '',
      actions: true,
      cell: (c) =>
        editingId === c.id ? (
          <>
            <Button
              small
              disabled={update.isPending || draft.trim().length < 2}
              onClick={() => {
                update.mutate({ id: c.id, name: draft.trim() });
                setEditingId(null);
              }}
            >
              Save
            </Button>
            <Button small variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
          </>
        ) : (
          <>
            <Button small variant="ghost" onClick={() => { setEditingId(c.id); setDraft(c.name); }}>Rename</Button>
            <Button small variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: c.id, status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>
              {c.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
            </Button>
            {canDelete && c.productCount === 0 && (
              <Button
                small
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Delete the category "${c.name}"? This cannot be undone.`)) remove.mutate(c.id);
                }}
              >
                Delete
              </Button>
            )}
          </>
        ),
    });
  }

  return (
    <details className="my-4 rounded-xl border border-line bg-card p-4 sm:p-5">
      <summary className="cursor-pointer text-lg font-semibold">Categories{list.data ? ` (${list.data.categories.length})` : ''}</summary>
      <div className="mt-3">
        <Muted small>
          Categories group products. A category that products use is switched off instead of deleted, so old products keep it.
        </Muted>
        {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
        {list.data && <DataTable rows={list.data.categories} columns={columns} rowKey={(c) => c.id} dim={(c) => c.status !== 'ACTIVE'} empty="No categories yet." />}
        {(update.isError || remove.isError) && <ErrorText>{errorMessage(update.error ?? remove.error)}</ErrorText>}

        {canManage && (
          <Card as="form" onSubmit={submit} className="mb-0">
            <SectionTitle first>Add a category</SectionTitle>
            <Field label="Name">
              <Input required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rice and grains" />
            </Field>
            <Button type="submit" className="mt-3" disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add category'}</Button>
            {create.isError && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          </Card>
        )}
      </div>
    </details>
  );
}