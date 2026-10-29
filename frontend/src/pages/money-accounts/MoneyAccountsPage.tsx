import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { MoneyAccount } from '../../api/types';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, Check, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select, type Column } from '../../components/ui';
import { moneyAccountBody, moneyAccountProblems } from '../../lib/moneyAccounts';
import { money } from '../../lib/stock';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// Where the company's money sits: a cash drawer in each store, bank accounts, mobile-money wallets.
// The balance is read from the accounting books, so it always agrees with them.
export function MoneyAccountsPage() {
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const { usable } = useLocations('cash.manage');
  const [showOff, setShowOff] = useState(false);
  const list = useQuery({ queryKey: ['money-accounts', { showOff }], queryFn: () => api<{ accounts: MoneyAccount[] }>(`/money-accounts?status=${showOff ? 'ALL' : 'ACTIVE'}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['money-accounts'] });

  const companyWide = me.permissions['cash.manage'] === 'company';
  const [name, setName] = useState('');
  const [type, setType] = useState<'CASH' | 'BANK'>('CASH');
  const [locationId, setLocationId] = useState('');
  const keyFor = useIdempotencyKey();
  const create = useMutation({
    mutationFn: () => {
      const body = moneyAccountBody(name, type, locationId);
      return api('/money-accounts', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: () => { setName(''); void refresh(); },
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const update = useMutation({
    mutationFn: (v: { id: string; name?: string; status?: 'ACTIVE' | 'INACTIVE' }) => {
      const { id, ...body } = v;
      return api(`/money-accounts/${id}`, { method: 'PATCH', body, idempotencyKey: keyFor({ id, ...body }) });
    },
    onSuccess: () => void refresh(),
  });
  const problems = moneyAccountProblems(name, type, locationId);
  const canManage = can('cash.manage');
  const mine = (a: MoneyAccount) => (a.type === 'CASH' ? !!a.location && (companyWide || me.locationIds.includes(a.location.id)) : companyWide);

  const columns: Column<MoneyAccount>[] = [
    { header: 'Account', primary: true, cell: (a) => (editingId === a.id ? <Input aria-label="New name" value={draft} maxLength={80} onChange={(e) => setDraft(e.target.value)} /> : a.name) },
    { header: 'Kind', cell: (a) => (a.type === 'CASH' ? `Cash drawer${a.location ? ` · ${a.location.name}` : ''}` : 'Bank or wallet') },
    { header: 'Balance (USD)', cell: (a) => <span className="font-semibold">{money(a.balance)}</span> },
    { header: 'Status', cell: (a) => <Badge tone={a.status === 'ACTIVE' ? 'ok' : 'off'}>{a.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
  ];
  if (canManage) {
    columns.push({
      header: '',
      actions: true,
      cell: (a) =>
        !mine(a) ? null : editingId === a.id ? (
          <>
            <Button small disabled={update.isPending || draft.trim().length < 2} onClick={() => { update.mutate({ id: a.id, name: draft.trim() });
              setEditingId(null); }}>
                Save
            </Button>
            <Button small variant="ghost"
              onClick={() => setEditingId(null)}>
                Cancel
            </Button>
          </>
        ) : (
          <>
            <Button small variant="ghost"
              onClick={() => { setEditingId(a.id); setDraft(a.name); }}>
                Rename
            </Button>
            <Button small variant="ghost" disabled={update.isPending} 
              onClick={() => update.mutate({ id: a.id, status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })}>
                {a.status === 'ACTIVE' ? 'Switch off' : 'Switch on'}
              </Button>
          </>
        ),
    });
  }

  return (
    <>
      <PageTitle>Cash and bank</PageTitle>
      <Muted>Where your money sits. Each store has its own cash drawer. The balance comes from the accounting books.</Muted>
      <div className="mt-3">
        <Check label="Show switched-off accounts" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} />
      </div>
      {list.isLoading && <Muted className="mt-3">Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={list.data.accounts} columns={columns} rowKey={(a) => a.id} dim={(a) => a.status !== 'ACTIVE'} empty="No cash drawers or bank accounts yet." />}
      {update.isError && <ErrorText>{errorMessage(update.error)}</ErrorText>}

      {canManage && (
        <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) create.mutate(); }}>
          <SectionTitle first>Add an account</SectionTitle>
          <FieldRow>
            <Field label="Name">
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Store A drawer" />
            </Field>
            <Field label="Kind">
              <Select value={type} onChange={(e) => setType(e.target.value as 'CASH' | 'BANK')}>
                <option value="CASH">Cash drawer (in a store)</option>
                {companyWide && <option value="BANK">Bank or mobile-money account</option>}
              </Select>
            </Field>
            {type === 'CASH' && (
              <Field label="Which place?">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Choose a place</option>
                  {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              </Field>
            )}
          </FieldRow>
          {name && problems.length > 0 && <Muted small>{problems.join('. ')}.</Muted>}
          <Button type="submit" disabled={problems.length > 0 || create.isPending}>{create.isPending ? 'Adding…' : 'Add account'}</Button>
          {create.isError && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        </Card>
      )}
    </>
  );
}