import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { StockCount } from '../../api/types';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { checkReason, COUNT_LABEL } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

type Line = StockCount['lines'][number];

export function CountDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['count', id], queryFn: () => api<{ count: StockCount }>(`/counts/${id}`) });
  const keyFor = useIdempotencyKey();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: ({ what, body }: { what: string; body: object }) => api(`/counts/${id}/${what}`, { method: 'POST', body, idempotencyKey: keyFor({ id, what, body }) }),
    onSuccess: () => {
      setRejecting(false);
      for (const k of ['count', 'counts', 'stock', 'stock-movements']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const c = q.data.count;
  const own = c.countedById === me.user.id && me.role !== 'ADMIN';
  const mayDecide = c.status === 'SUBMITTED' && can('stock.adjust_approve') && !own;
  const diff = (l: Line) => Number(l.difference);
  const columns: Column<Line>[] = [
    { header: 'Product', primary: true, cell: (l) => <><span className="font-semibold">{l.product.name}</span><div className="text-sm font-normal text-muted">{l.product.sku}</div></> },
    { header: 'System said', cell: (l) => `${trimNumber(l.expectedQty)} ${l.product.baseUnit}` },
    { header: 'Counted', cell: (l) => `${trimNumber(l.countedQty)} ${l.product.baseUnit}` },
    { header: 'Difference', cell: (l) => <span className={diff(l) < 0 ? 'font-semibold text-danger' : 'font-semibold'}>{diff(l) > 0 ? '+' : ''}{trimNumber(l.difference)} {l.product.baseUnit}</span> },
    { header: 'Why', cell: (l) => l.reason ?? '' },
  ];
  return (
    <>
      <p className="mb-2">
        <Link to="/counts">← Stock counts</Link>
      </p>
      <PageTitle>
        {c.number}
        <Badge
          tone={c.status === 'SUBMITTED' ? 'wait'
            : c.status === 'APPROVED' ? 'ok' : 'off'}
        >{COUNT_LABEL[c.status]}
        </Badge>
      </PageTitle>
      <Muted>
        {c.location.name} · counted {day(c.countedAt)}{c.approvedAt ? ` · approved ${day(c.approvedAt)}` : ''}
      </Muted>
      {c.note &&
        <p className="mt-2 whitespace-pre-line">
          {c.note}
        </p>}
      <SectionTitle>Result</SectionTitle>
      <DataTable
        rows={c.lines}
        columns={columns}
        rowKey={(l) => l.id} empty="No lines."
      />
      <div className="mt-5 space-y-3">
        {act.isError && <ErrorText>{errorMessage(act.error)}</ErrorText>}
        {c.status === 'SUBMITTED' && own &&
          <Muted>
            Someone else must approve this count.
          </Muted>
        }
        {mayDecide && !rejecting && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => act.mutate({ what: 'approve', body: {} })}
              disabled={act.isPending}
            >
              {act.isPending ? 'Saving…' : 'Approve: change the stock to the counted figures'}
            </Button>
            <Button variant="ghost" onClick={() => setRejecting(true)}>Reject</Button>
          </div>
        )}
        {mayDecide && rejecting && (
          <Card
            as="form"
            onSubmit={(e) => { e.preventDefault(); if (!checkReason(reason)) act.mutate({ what: 'reject', body: { reason: reason.trim() } }); }} className="border-warn">
            <div className="font-semibold">
              Reject this count?
            </div>
            <Muted small>
              Nothing changes. The counter can count again.
            </Muted>
            <Field
              label="Reason"
              error={reason ? checkReason(reason) : undefined}
              className="mt-3 block">
              <Input
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <div className="mt-3 flex gap-2">
              <Button
                type="submit"
                variant="danger"
                disabled={!!checkReason(reason) || act.isPending}>
                Reject count
              </Button>
              <Button
                variant="ghost"
                onClick={() => setRejecting(false)}>
                Back
              </Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}