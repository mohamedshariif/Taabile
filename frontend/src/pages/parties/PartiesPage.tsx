import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Customer, PartyPage, Supplier } from '../../api/types';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Field, Input, Muted, PageTitle, Select, type Column } from '../../components/ui';
import { creditText, describeBalance, type PartyKind } from '../../lib/parties';
import { KINDS } from '../../features/parties/kinds';

type Party = Customer | Supplier;
type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL';

// One list screen for both customers and suppliers: search, active/switched off, "show more", and each one's balance.
export function PartiesPage({ kind }: { kind: PartyKind }) {
  const k = KINDS[kind];
  const { can } = useAuth();
  const me = useMe();
  const navigate = useNavigate();

  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('ACTIVE');
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const list = useInfiniteQuery({
    queryKey: [k.path, { search, status }],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ status, limit: '50' });
      if (search) qs.set('search', search);
      if (pageParam) qs.set('cursor', pageParam);
      return api<PartyPage<Party>>(`/${k.path}?${qs.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const columns: Column<Party>[] = [
    {
      header: k.plural.slice(0, -1),
      primary: true,
      cell: (p) => (
        <>
          <Link to={`/${k.path}/${p.id}`}>{p.name}</Link>
          <div className="text-sm font-normal text-muted">{p.code}</div>
        </>
      ),
    },
    { header: 'Phone', cell: (p) => p.phone ?? '—' },
    kind === 'customer'
      ? { header: 'Credit', cell: (p) => creditText((p as Customer).creditLimit, p.paymentTermsDays) }
      : { header: 'Payment terms', cell: (p) => (p.paymentTermsDays ? `${p.paymentTermsDays} days` : 'Pay at once') },
    { header: 'Balance', cell: (p) => <span className={Number(p.balance) === 0 ? 'text-muted' : 'font-semibold'}>{describeBalance(kind, p.balance, me.company.currency)}</span> },
    { header: 'Status', cell: (p) => <Badge tone={p.status === 'ACTIVE' ? 'ok' : 'off'}>{p.status === 'ACTIVE' ? 'Active' : 'Switched off'}</Badge> },
  ];

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>{k.plural}</PageTitle>
          <Muted>{k.blurb}</Muted>
        </div>
        {can(k.manage) && <Button onClick={() => navigate(`/${k.path}/new`)}>New {k.one}</Button>}
      </div>

      <div className="my-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Search">
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, code or phone" autoComplete="off" />
        </Field>
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Switched off</option>
            <option value="ALL">All</option>
          </Select>
        </Field>
      </div>

      {list.isLoading && <Muted>Loading…</Muted>}
      {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {list.data && (
        <DataTable rows={rows} columns={columns} rowKey={(p) => p.id} dim={(p) => p.status !== 'ACTIVE'} empty={search ? `No ${k.one} matches. Try a different search.` : `No ${k.plural.toLowerCase()} yet.`} />
      )}
      {list.hasNextPage && (
        <div className="my-3 text-center">
          <Button variant="ghost" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      )}
    </>
  );
}