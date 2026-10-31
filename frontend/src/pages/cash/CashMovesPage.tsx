import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CashTransfer, PartyPage } from '../../api/types';
import { Badge, Button, DataTable, ErrorText, Field, FieldRow, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { TRANSFER_LABEL } from '../../lib/cash';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

// Money moving between drawers and the bank. Cash that leaves a drawer is "on its way" until the other side confirms.
export function CashMovesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['cash-transfers', { status }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<CashTransfer>>(`/cash/transfers?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<CashTransfer>[] = [
    { header: 'Movement', primary: true, cell: (t) => <><Link to={`/cash/moves/${t.id}`}>{t.number}</Link><div className="text-sm font-normal text-muted">{day(t.occurredAt)} · {TRANSFER_LABEL[t.type]}</div></> },
    { header: 'From → to', cell: (t) => `${t.from.name} → ${t.to.name}` },
    { header: 'Amount (USD)', cell: (t) => <span className="font-semibold">{money(t.amount)}</span> },
    { header: 'Status', cell: (t) => (t.status === 'PENDING' ? <Badge tone="wait">On its way</Badge> : <Badge tone="ok">Done</Badge>) },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Cash movements</PageTitle>
          <Muted>Deposits to the bank, cash between stores, and withdrawals. Count a drawer to check it against the books.</Muted>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => navigate('/cash/moves/new')}>Move money</Button>
          <Button variant="ghost" onClick={() => navigate('/cash/count')}>Count a drawer</Button>
        </div>
      </div>
      <FieldRow>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="PENDING">On its way (waiting to be confirmed)</option>
            <option value="CONFIRMED">Done</option>
          </Select>
        </Field>
      </FieldRow>
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(t) => t.id} empty="No cash movements yet." />}
      {list.hasNextPage && <div className="my-3 text-center"><Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button></div>}
    </>
  );
}