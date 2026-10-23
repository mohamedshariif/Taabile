import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import type { Category, ProductPage, ProductSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, Input, Muted, PageTitle, Select, type Column } from '../components/ui';
import { unitsLine } from '../lib/products';
import { CategoriesCard } from './CategoriesCard';

type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL';

export function ProductsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const canManage = can('products.manage');

  // The search box updates the list a moment after you stop typing, so we do not ask the server on every key.
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ACTIVE');
  const [categoryId, setCategoryId] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/categories') });
  const list = useInfiniteQuery({
    queryKey: ['products', { search, status, categoryId }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ status, limit: '50' });
      if (search) qs.set('search', search);
      if (categoryId) qs.set('categoryId', categoryId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<ProductPage>(`/products?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  // A barcode scanner types the code and presses Enter. If the text is exactly one unit's barcode, open that product.
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const openByBarcode = async () => {
    const code = text.trim();
    setScanMessage(null);
    if (!/^[A-Za-z0-9._-]{4,32}$/.test(code)) return;
    try {
      const r = await api<{ product: { id: string } }>(`/products/by-barcode/${encodeURIComponent(code)}`);
      navigate(`/products/${r.product.id}`);
    } catch (e) {
      // Not a barcode (maybe a product code or part of a name): the normal search results stay on screen.
      if (!(e instanceof ApiError && e.status === 404)) setScanMessage(errorMessage(e));
    }
  };

  const columns: Column<ProductSummary>[] = [
    {
      header: 'Product',
      primary: true,
      cell: (p) => (
        <>
          <Link to={`/products/${p.id}`}>{p.name}</Link>
          <div className="text-sm font-normal text-muted">{p.sku}</div>
        </>
      ),
    },
    { header: 'Category', cell: (p) => p.category?.name ?? '—' },
    { header: 'Units', cell: (p) => unitsLine(p) },
    { header: 'Status', cell: (p) => <Badge tone={p.status === 'ACTIVE' ? 'ok' : 'off'}>{p.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Products</PageTitle>
          <Muted>What you buy and sell. Each product has one base unit and any number of package sizes.</Muted>
        </div>
        {canManage && <Button onClick={() => navigate('/products/new')}>New product</Button>}
      </div>

      <div className="my-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Field label="Search" hint="Scan a barcode and press Enter to open that product.">
          <Input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void openByBarcode();
              }
            }}
            placeholder="Name, code or barcode"
            autoComplete="off"
            enterKeyHint="search"
          />
        </Field>
        <Field label="Category">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>
            {(categories.data?.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.status === 'ACTIVE' ? '' : ' (switched off)'}</option>
            ))}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="ACTIVE">Active products</option>
            <option value="INACTIVE">Switched off</option>
            <option value="ALL">All</option>
          </Select>
        </Field>
      </div>

      {scanMessage && <ErrorText>{scanMessage}</ErrorText>}
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(p) => p.id}
          dim={(p) => p.status !== 'ACTIVE'}
          empty={search || categoryId ? 'No product matches. Try a different search.' : 'No products yet.'}
        />
      )}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}

      <CategoriesCard />
    </>
  );
}