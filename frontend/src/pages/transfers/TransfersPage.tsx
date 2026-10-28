import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PartyPage, TransferSummary } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { TRANSFER_LABEL } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

const tone = (s: string) => (s === 'DISCREPANCY' || s === 'REQUESTED' ? 'wait' : s === 'REJECTED' || s === 'CANCELLED' || s === 'CLOSED' ? 'off' : 'ok');

// Moving goods between places: asked for, sent, received.
export function TransfersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['transfers', { status }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<TransferSummary>>(`/transfers?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: Column<TransferSummary>[] = [
    {
      header: 'Transfer',
      primary: true,
      cell: (t) => (
        <>
          <Link to={`/transfers/${t.id}`}>{t.number}</Link>
          <div className="text-sm font-normal text-muted">{day(t.requestedAt)}</div>
        </>
      ),
    },
    { header: 'From', cell: (t) => t.from.name },
    { header: 'To', cell: (t) => t.to.name },
    { header: 'Products', cell: (t) => t.products },
    { header: 'Status', cell: (t) => <Badge tone={tone(t.status)}>{TRANSFER_LABEL[t.status]}</Badge> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Transfers</PageTitle>
          <Muted>Goods moving between your stores and warehouses. The cost goes with the goods.</Muted>
        </div>
        {can('stock.transfer') && <Button onClick={() => navigate('/transfers/new')}>New transfer</Button>}
      </div>
      <div className="my-4 max-w-xs">
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(TRANSFER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
      </div>
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(t) => t.id} dim={(t) => ['REJECTED', 'CANCELLED'].includes(t.status)} empty="No transfers yet." />}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button>
        </div>
      )}
    </>
  );
}