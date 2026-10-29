import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Sale } from '../../api/types';
import { useAuth, useMe } from '../../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { FULFILL_LABEL, PAYMENT_LABEL } from '../../lib/sales';
import { checkReason, money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

type Line = Sale['lines'][number];

// One sale: what was sold, what was paid, where the goods come from, and what can still be done with it.
export function SaleDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sale', id], queryFn: () => api<{ sale: Sale }>(`/sales/${id}`) });
  const keyFor = useIdempotencyKey();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const act = useMutation({
    mutationFn: ({ what, body }: { what: string; body: object }) => api(`/sales/${id}/${what}`, { method: 'POST', body, idempotencyKey: keyFor({ id, what, body }) }),
    onSuccess: () => {
      setVoiding(false);
      for (const k of ['sale', 'sales', 'stock', 'stock-movements', 'money-accounts', 'customers', 'pending-release']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const s = q.data.sale;

  const atSale = me.permissions['sales.void'] === 'company' || me.locationIds.includes(s.location.id);
  const mayVoid = can('sales.void') && atSale && s.status === 'POSTED';
  const mayReleaseAt = (locId: string) => can('stock.release') && (me.permissions['stock.release'] === 'company' || me.locationIds.includes(locId));
  const waiting = s.lines.flatMap((l) => l.allocations).filter((a) => Number(a.remaining) > 0);
  const mayRelease = s.status === 'POSTED' && waiting.some((a) => mayReleaseAt(a.supplyLocation.id));

  const columns: Column<Line>[] = [
    { header: 'Product', primary: true, cell: (l) => <><span className="font-semibold">{l.product.name}</span><div className="text-sm font-normal text-muted">{l.product.sku}</div></> },
    { header: 'Quantity', cell: (l) => `${trimNumber(l.quantity)} ${l.unit.name}` },
    { header: 'Price', cell: (l) => money(l.unitPrice) },
    { header: 'Total', cell: (l) => <span className="font-semibold">{money(l.lineTotal)}</span> },
    {
      header: 'Goods from',
      cell: (l) => (
        <ul className="text-sm">
          {l.allocations.map((a) => (
            <li key={a.id}>
              {a.supplyLocation.name}: {trimNumber(a.qtyBase)} {l.product.baseUnit}
              {Number(a.remaining) > 0 ? <span className="text-warn"> · {trimNumber(a.remaining)} waiting</span> : ''}
            </li>
          ))}
        </ul>
      ),
    },
  ];

  return (
    <>
      <p className="mb-2"><Link to="/sales">← Sales</Link></p>
      <PageTitle>
        {s.number}{' '}
        {s.status === 'VOIDED' ? <Badge tone="off">Voided</Badge> : (
          <>
            <Badge tone={s.paymentStatus === 'PAID' ? 'ok' : 'wait'}>{PAYMENT_LABEL[s.paymentStatus]}</Badge>{' '}
            <Badge tone={s.fulfillmentStatus === 'COMPLETE' ? 'ok' : 'wait'}>{FULFILL_LABEL[s.fulfillmentStatus]}</Badge>
          </>
        )}
      </PageTitle>
      <Muted>{s.location.name} · {day(s.soldAt)} · {s.customer ? s.customer.name : 'Walk-in customer'}{s.dueDate ? ` · due ${day(s.dueDate)}` : ''}</Muted>
      {s.status === 'VOIDED' && <p className="mt-2 text-danger">Voided{s.voidedAt ? ` on ${day(s.voidedAt)}` : ''}: {s.voidReason}</p>}
      {s.note && <p className="mt-2 whitespace-pre-line">{s.note}</p>}

      <SectionTitle>Goods</SectionTitle>
      <DataTable rows={s.lines} columns={columns} rowKey={(l) => l.id} empty="No lines." />

      <Card>
        <div className="flex justify-between"><span>Subtotal</span><span>{money(s.subtotal)}</span></div>
        {Number(s.discountTotal) > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(s.discountTotal)}</span></div>}
        {Number(s.taxTotal) > 0 && <div className="flex justify-between"><span>Tax</span><span>{money(s.taxTotal)}</span></div>}
        <div className="flex justify-between text-xl font-bold"><span>Total (USD)</span><span>{money(s.total)}</span></div>
        <div className="flex justify-between"><span>Paid</span><span>{money(s.paidTotal)}</span></div>
        {s.status === 'POSTED' && Number(s.owed) > 0 && <div className="flex justify-between font-semibold text-warn"><span>Still owed</span><span>{money(s.owed)}</span></div>}
      </Card>

      {s.payments.length > 0 && (
        <>
          <SectionTitle>Payments</SectionTitle>
          <ul className="space-y-1">
            {s.payments.map((p) => <li key={p.id}>{p.number} · {money(p.amount)} into {p.account} · {day(p.paidAt)}{p.status === 'VOIDED' ? ' (cancelled with the sale)' : ''}</li>)}
          </ul>
        </>
      )}

      <div className="mt-5 space-y-3">
        {act.isError && <ErrorText>{errorMessage(act.error)}</ErrorText>}
        {mayRelease && (
          <div>
            <Muted small>Goods from your place that are still waiting to be handed over.</Muted>
            <Button className="mt-1" disabled={act.isPending} onClick={() => act.mutate({ what: 'release', body: {} })}>{act.isPending ? 'Saving…' : 'Release the goods from my place'}</Button>
          </div>
        )}
        {mayVoid && !voiding && <Button variant="ghost" onClick={() => setVoiding(true)}>Void this sale</Button>}
        {mayVoid && voiding && (
          <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!checkReason(reason)) act.mutate({ what: 'void', body: { reason: reason.trim() } }); }} className="border-warn">
            <div className="font-semibold">Void this sale?</div>
            <Muted small>Goods that already left go back into stock, goods still reserved are freed, the money taken is returned in the books, and the customer's balance is corrected. The sale stays on record as voided.</Muted>
            <Field label="Reason" error={reason ? checkReason(reason) : undefined} className="mt-3 block"><Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="mt-3 flex gap-2">
              <Button type="submit" variant="danger" disabled={!!checkReason(reason) || act.isPending}>Void sale</Button>
              <Button variant="ghost" onClick={() => setVoiding(false)}>Back</Button>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}