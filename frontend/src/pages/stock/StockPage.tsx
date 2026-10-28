import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { StockItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Button, DataTable, ErrorText, Field, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { money, stockLine } from '../../lib/stock';
import { useLocations } from '../../features/stock/hooks';

// What is on the shelves: one row per product per place, in the base unit and in packages. Costs only for people allowed to see them.
export function StockPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { all: locations } = useLocations();
  const [locationId, setLocationId] = useState('');
  const [inStock, setInStock] = useState<'true' | 'false'>('true');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const list = useInfiniteQuery({
    queryKey: ['stock', { locationId, inStock, search }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ inStock, limit: '50' });
      if (locationId) qs.set('locationId', locationId);
      if (search) qs.set('search', search);
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ items: StockItem[]; nextCursor: string | null }>(`/stock?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const seeCost = rows.some((r) => r.avgCost !== null);

  const columns: Column<StockItem>[] = [
    {
      header: 'Product',
      primary: true,
      cell: (s) => (
        <>
          <Link to={`/stock/movements?productId=${s.product.id}&locationId=${s.location.id}`}>{s.product.name}</Link>
          <div className="text-sm font-normal text-muted">{s.product.sku}</div>
        </>
      ),
    },
    { header: 'Where', cell: (s) => s.location.name },
    {
      header: 'In stock',
      cell: (s) => (
        <>
          <span className="font-semibold">{stockLine(s.onHand, s.product.baseUnit, s.packages)}</span>
          {Number(s.committed) > 0 && <div className="text-sm text-muted">{s.available} available, {s.committed} reserved</div>}
        </>
      ),
    },
    ...(seeCost
      ? [
          { header: 'Cost per unit', cell: (s: StockItem) => `${money(s.avgCost)} / ${s.product.baseUnit}` },
          { header: 'Value', cell: (s: StockItem) => money(s.value) },
        ]
      : []),
  ];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Stock</PageTitle>
          <Muted>What is on the shelves at each place right now.</Muted>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => navigate('/stock/movements')}>History</Button>
          {can('stock.adjust_approve') && <Button variant="ghost" onClick={() => navigate('/stock/adjust')}>Adjust stock</Button>}
          {can('import.run') && <Button onClick={() => navigate('/stock/opening')}>Opening stock</Button>}
        </div>
      </div>

      <div className="my-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Search">
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Product name or code" autoComplete="off" />
        </Field>
        <Field label="Where">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All places</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={inStock} onChange={(e) => setInStock(e.target.value as 'true' | 'false')}>
            <option value="true">Only what is in stock</option>
            <option value="false">Everything, even empty</option>
          </Select>
        </Field>
      </div>

      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(s) => s.id} empty={search ? 'No product matches. Try a different search.' : 'No stock here yet. Enter opening stock or receive a purchase.'} />}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button>
        </div>
      )}
    </>
  );
}