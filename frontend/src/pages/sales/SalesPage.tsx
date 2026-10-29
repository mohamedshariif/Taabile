import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PartyPage, SaleSummary } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { FULFILL_LABEL, PAYMENT_LABEL } from '../../lib/sales';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

// Sales, newest first. Staff see only their own; a Manager sees their place; the Admin and Viewer see everything.
export function SalesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pay, setPay] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['sales', { search, status, pay }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (search.trim()) qs.set('search', search.trim());
      if (status) qs.set('status', status);
      if (pay) qs.set('paymentStatus', pay);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<SaleSummary>>(`/sales?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<SaleSummary>[] = [
    { header: 'Invoice', primary: true, cell: (s) => <><Link to={`/sales/${s.id}`}>{s.number}</Link><div className="text-sm font-normal text-muted">{day(s.soldAt)}</div></> },
    { header: 'Where', cell: (s) => s.location.name },
    { header: 'Customer', cell: (s) => s.customer?.name ?? 'Walk-in' },
    { header: 'Total (USD)', cell: (s) => <span className="font-semibold">{money(s.total)}</span> },
    {
      header: 'Status',
      cell: (s) =>
        s.status === 'VOIDED' ? <Badge tone="off">Voided</Badge> : (
          <span className="flex flex-wrap gap-1">
            <Badge tone={s.paymentStatus === 'PAID' ? 'ok' : 'wait'}>{PAYMENT_LABEL[s.paymentStatus]}</Badge>
            {s.fulfillmentStatus !== 'COMPLETE' && <Badge tone="wait">{FULFILL_LABEL[s.fulfillmentStatus]}</Badge>}
          </span>
        ),
    },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Sales</PageTitle>
          <Muted>Every sale, with what was paid and whether the goods have been handed over.</Muted>
        </div>
        {can('sales.create') && <Button onClick={() => navigate('/sales/new')}>New sale</Button>}
      </div>
      <FieldRow>
        <Field label="Invoice number"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="INV-000001" /></Field>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="POSTED">Valid sales</option>
            <option value="VOIDED">Voided sales</option>
          </Select>
        </Field>
        <Field label="Payment">
          <Select value={pay} onChange={(e) => setPay(e.target.value)}>
            <option value="">Any</option>
            <option value="PAID">Paid</option>
            <option value="PARTIAL">Part paid</option>
            <option value="UNPAID">Not paid</option>
          </Select>
        </Field>
      </FieldRow>
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(s) => s.id} dim={(s) => s.status === 'VOIDED'} empty="No sales yet." />}
      {list.hasNextPage && <div className="my-3 text-center"><Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button></div>}
    </>
  );
}