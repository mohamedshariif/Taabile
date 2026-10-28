import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Receipt } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Muted, PageTitle, SectionTitle, type Column } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { checkReason, COST_LABEL, money } from '../../lib/stock';
import { day } from './PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

type Line = Receipt['lines'][number];

export function PurchaseDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['purchase', id], queryFn: () => api<{ receipt: Receipt }>(`/purchases/${id}`) });
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const keyFor = useIdempotencyKey();
  const cancel = useMutation({
    mutationFn: () => {
      const body = { reason: reason.trim() };
      return api(`/purchases/${id}/void`, { method: 'POST', body, idempotencyKey: keyFor({ id, ...body }) });
    },
    onSuccess: () => {
      setCancelling(false);
      setReason('');
      for (const k of ['purchase', 'purchases', 'stock', 'stock-movements', 'suppliers']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const r = q.data.receipt;

  const columns: Column<Line>[] = [
    { header: 'Product', primary: true, cell: (l) => <><span className="font-semibold">{l.product.name}</span><div className="text-sm font-normal text-muted">{l.product.sku}</div></> },
    { header: 'Received', cell: (l) => `${trimNumber(l.qtyReceived)} × ${l.unit.name} (${trimNumber(l.qtyReceivedBase)} ${l.product.baseUnit})` },
    { header: 'Damaged', cell: (l) => (Number(l.qtyDamaged) > 0 ? trimNumber(l.qtyDamaged) : '—') },
    { header: 'Price', cell: (l) => money(l.unitPrice) },
    { header: 'Line total', cell: (l) => money(l.lineTotal) },
    { header: 'Real cost per unit', cell: (l) => `${money(l.landedUnitCostBase)} / ${l.product.baseUnit}` },
  ];

  return (
    <>
      <p className="mb-2"><Link to="/purchases">← Purchases</Link></p>
      <PageTitle>{r.number} {r.status === 'VOIDED' && <Badge tone="off">Cancelled</Badge>}</PageTitle>
      <Muted>
        {r.supplier.name} · {r.location.name} · received {day(r.receivedAt)}
        {r.supplierInvoiceRef ? ` · invoice ${r.supplierInvoiceRef}` : ''}
        {r.containerRef ? ` · container ${r.containerRef}` : ''}
        {r.dueDate ? ` · due ${r.dueDate}` : ''}
      </Muted>
      {r.note && <p className="mt-2">{r.note}</p>}

      <SectionTitle>Goods</SectionTitle>
      <DataTable rows={r.lines} columns={columns} rowKey={(l) => l.id} empty="No lines." />

      {r.costs.length > 0 && (
        <>
          <SectionTitle>Freight and other costs</SectionTitle>
          <ul className="space-y-1">
            {r.costs.map((c) => <li key={c.id}>{COST_LABEL[c.type]}: <span className="font-semibold">{money(c.amount)}</span>{c.note ? ` · ${c.note}` : ''}</li>)}
          </ul>
        </>
      )}

      <Card className="mt-5">
        <div>Goods {money(r.goodsTotal)} · landed costs {money(r.costTotal)}</div>
        <div className="font-semibold">We owe the supplier {money(r.total)} (paid so far {money(r.paidTotal)})</div>
      </Card>

      {r.status === 'POSTED' && can('purchases.manage') && (
        <div className="mt-5">
          {!cancelling ? (
            <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel this purchase</Button>
          ) : (
            <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!checkReason(reason)) cancel.mutate(); }} className="border-warn">
              <div className="font-semibold">Cancel this purchase?</div>
              <Muted small>The stock is taken back out and what you owe the supplier is reversed. It only works while the goods have not been used (sold, moved or adjusted). The receipt stays on record as cancelled.</Muted>
              <Field label="Reason" error={reason ? checkReason(reason) : undefined} className="mt-3 block">
                <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="mt-3 flex gap-2">
                <Button type="submit" variant="danger" disabled={cancel.isPending || !!checkReason(reason)}>{cancel.isPending ? 'Cancelling…' : 'Cancel purchase'}</Button>
                <Button variant="ghost" onClick={() => setCancelling(false)}>Keep it</Button>
              </div>
              {cancel.isError && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
            </Card>
          )}
        </div>
      )}
    </>
  );
}