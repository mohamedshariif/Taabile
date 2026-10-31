import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Expense, ExpensePage } from '../../api/types';
import { Badge, Button, Card, DataTable, ErrorText, Field, FieldRow, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

// Money paid out for the business: rent, fuel, repairs. A Manager sees their own places; the Admin sees everything.
export function ExpensesPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('POSTED');
  const [categoryId, setCategoryId] = useState('');
  const cats = useQuery({ queryKey: ['expense-categories'], queryFn: () => api<{ categories: { id: string; name: string }[] }>('/expenses/categories') });
  const list = useInfiniteQuery({
    queryKey: ['expenses', { search, status, categoryId }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (search.trim()) qs.set('search', search.trim());
      if (status) qs.set('status', status);
      if (categoryId) qs.set('categoryId', categoryId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<ExpensePage>(`/expenses?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  const columns: Column<Expense>[] = [
    { header: 'Expense', primary: true, cell: (e) => <><Link to={`/expenses/${e.id}`}>{e.number}</Link><div className="text-sm font-normal text-muted">{day(e.incurredOn)}</div></> },
    { header: 'What', cell: (e) => <>{e.category.name}<div className="text-sm text-muted">{e.description}</div></> },
    { header: 'Place', cell: (e) => e.location?.name ?? 'Company-wide' },
    { header: 'Paid from', cell: (e) => e.account?.name ?? '—' },
    { header: 'Amount (USD)', cell: (e) => <span className="font-semibold">{money(e.amount)}</span> },
    { header: 'Status', cell: (e) => (e.status === 'VOIDED' ? <Badge tone="off">Cancelled</Badge> : <Badge tone="ok">Posted</Badge>) },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Expenses</PageTitle>
          <Muted>Money paid out for the business, taken from a cash drawer or bank account.</Muted>
        </div>
        <Button onClick={() => navigate('/expenses/new')}>New expense</Button>
      </div>
      <FieldRow>
        <Field label="Search"><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Fuel, EX-000001" /></Field>
        <Field label="Kind of cost">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All</option>
            {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="POSTED">Valid expenses</option>
            <option value="VOIDED">Cancelled</option>
            <option value="">All</option>
          </Select>
        </Field>
      </FieldRow>
      {total !== undefined && <Card><div className="flex justify-between"><span>Total of valid expenses shown</span><span className="text-lg font-bold">{money(total)} USD</span></div></Card>}
      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && <DataTable rows={rows} columns={columns} rowKey={(e) => e.id} dim={(e) => e.status === 'VOIDED'} empty="No expenses yet." />}
      {list.hasNextPage && <div className="my-3 text-center"><Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</Button></div>}
    </>
  );
}