import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PartyPage, ReceiptSummary, Supplier } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { money } from '../../lib/stock';

export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

// Goods received from suppliers, newest first.
export function PurchasesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [supplierId, setSupplierId] = useState('');
  const [status, setStatus] = useState<'ALL' | 'POSTED' | 'VOIDED'>('ALL');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const suppliers = useQuery({ queryKey: ['suppliers', 'pick'], queryFn: () => api<PartyPage<Supplier>>('/suppliers?status=ALL&limit=100') });
  const list = useInfiniteQuery({
    queryKey: ['purchases', { supplierId, status, search }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50', status });
      if (supplierId) qs.set('supplierId', supplierId);
      if (search) qs.set('search', search);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<ReceiptSummary>>(`/purchases?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: Column<ReceiptSummary>[] = [
    {
      header: 'Receipt',
      primary: true,
      cell: (r) => (
        <>
          <Link to={`/purchases/${r.id}`}>{r.number}</Link> {r.status === 'VOIDED' && <Badge tone="off">Cancelled</Badge>}
          <div className="text-sm font-normal text-muted">{day(r.receivedAt)} · {r.location.name}</div>
        </>
      ),
    },
    { header: 'Supplier', cell: (r) => r.supplier.name },
    { header: 'Their invoice', cell: (r) => r.supplierInvoiceRef ?? r.containerRef ?? '—' },
    { header: 'Goods', cell: (r) => money(r.goodsTotal) },
    { header: 'Landed costs', cell: (r) => (Number(r.costTotal) > 0 ? money(r.costTotal) : '—') },
    { header: 'We owe', cell: (r) => <span className="font-semibold">{money(r.total)}</span> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Purchases</PageTitle>
          <Muted>Goods received from suppliers, with freight and container costs.</Muted>
        </div>
        {can('purchases.manage') && <Button onClick={() => navigate('/purchases/new')}>Record a purchase</Button>}
      </div>

      <div className="my-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Search">
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Receipt number, invoice or container" autoComplete="off" />
        </Field>
        <Field label="Supplier">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">All suppliers</option>
            {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value as 'ALL' | 'POSTED' | 'VOIDED')}>
            <option value="ALL">All</option>
            <option value="POSTED">Recorded</option>
            <option value="VOIDED">Cancelled</option>
          </Select>
        </Field>
      </div>

      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} dim={(r) => r.status === 'VOIDED'} empty="No purchases yet." />}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button>
        </div>
      )}
    </>
  );
}