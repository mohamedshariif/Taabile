import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { CountSummary, PartyPage } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, DataTable, ErrorText, Muted, PageTitle, type Column } from '../../components/ui';
import { COUNT_LABEL } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';

// Stock counts: someone counts the shelf, someone else approves, and only then does stock change.
export function CountsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: ['counts'],
    queryFn: ({ pageParam }) => api<PartyPage<CountSummary>>(`/counts?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const columns: Column<CountSummary>[] = [
    {
      header: 'Count', primary: true, cell: (c) =>
        <>
          <Link to={`/counts/${c.id}`}>{c.number}</Link>
          <div className="text-sm font-normal text-muted">
            {day(c.countedAt)}
          </div>
        </>
    },
    { header: 'Where', cell: (c) => c.location.name },
    { header: 'Products', cell: (c) => c.products },
    { header: 'Status', cell: (c) => <Badge tone={c.status === 'SUBMITTED' ? 'wait' : c.status === 'APPROVED' ? 'ok' : 'off'}>{COUNT_LABEL[c.status]}</Badge> },
  ];
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Stock counts</PageTitle>
          <Muted>
            Count the shelf. A Manager or Admin approves, and only then does the system change its figures.
          </Muted>
        </div>
        {can('stock.count') &&
          <Button onClick={() => navigate('/counts/new')}>New count</Button>
        }
      </div>
      <div className="mt-4">
        {list.isLoading && <Muted>Loading…</Muted>}
        {list.isError && <ErrorText>{errorMessage(list.error)}</ErrorText>}
        {list.data &&
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(c) => c.id} dim={(c) => c.status === 'REJECTED'}
            empty="No counts yet."
          />}
        {list.hasNextPage &&
          <div className="my-3 text-center">
            <Button
              variant="ghost"
              onClick={() => void list.fetchNextPage()}>
              Show more
            </Button>
          </div>
        }
      </div>
    </>
  );
}