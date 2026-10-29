import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PartyPage, PaymentRecord } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

// Every payment in and out. Payments are never edited; a mistake is cancelled by the Admin from the payment's page.
export function PaymentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [party, setParty] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['payments', { party, status, search }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (party) qs.set('partyType', party);
      if (status) qs.set('status', status);
      if (search.trim()) qs.set('search', search.trim());
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<PaymentRecord>>(`/payments?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<PaymentRecord>[] = [
    { header: 'Payment', primary: true, cell: (p) => <><Link to={`/payments/${p.id}`}>{p.number}</Link><div className="text-sm font-normal text-muted">{day(p.paidAt)}</div></> },
    { header: 'Direction', cell: (p) => (p.partyType === 'CUSTOMER' ? <Badge tone="ok">Money in</Badge> : <Badge tone="wait">Money out</Badge>) },
    { header: 'Who', cell: (p) => p.customer?.name ?? p.supplier?.name ?? 'Walk-in customer' },
    { header: 'Account', cell: (p) => p.account.name },
    { header: 'Amount (USD)', cell: (p) => <span className="font-semibold">{money(p.amount)}</span> },
    { header: 'Status', cell: (p) => (p.status === 'VOIDED' ? <Badge tone="off">Cancelled</Badge> : <Badge tone="ok">Posted</Badge>) },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Payments</PageTitle>
          <Muted>Money received from customers and paid to suppliers.</Muted>
        </div>
        <div className="flex flex-wrap gap-2">
          {can('payments.receive') && <Button onClick={() => navigate('/payments/receive')}>Take payment</Button>}
          {can('payments.pay_supplier') && <Button variant="ghost" onClick={() => navigate('/payments/pay')}>Pay supplier</Button>}
        </div>
      </div>
      <FieldRow>
        <Field label="Number or reference"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="PM-000001" /></Field>
        <Field label="Show">
          <Select value={party} onChange={(e) => setParty(e.target.value)}>
            <option value="">Money in and out</option>
            <option value="CUSTOMER">Money in (customers)</option>
            <option value="SUPPLIER">Money out (suppliers)</option>
          </Select>
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="POSTED">Posted</option>
            <option value="VOIDED">Cancelled</option>
          </Select>
        </Field>
      </FieldRow>
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(p) => p.id} dim={(p) => p.status === 'VOIDED'} empty="No payments yet." />}
      {list.hasNextPage && <div className="my-3 text-center"><Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button></div>}
    </>
  );
}