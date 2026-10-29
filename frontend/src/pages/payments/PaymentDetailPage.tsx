import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PaymentRecord } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { Badge, Button, Card, ErrorText, Field, Input, Muted, PageTitle, SectionTitle } from '../../components/ui';
import { checkReason, money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

export function PaymentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payment', id], queryFn: () => api<{ payment: PaymentRecord }>(`/payments/${id}`) });
  const keyFor = useIdempotencyKey();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => {
      const body = { reason: reason.trim() };
      return api(`/payments/${id}/void`, { method: 'POST', body, idempotencyKey: keyFor({ id, body }) });
    },
    onSuccess: () => {
      setOpen(false);
      for (const k of ['payment', 'payments', 'payments-open', 'customers', 'suppliers', 'sales', 'sale', 'purchases', 'purchase', 'money-accounts']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
  if (q.isLoading) return <Muted>Loading…</Muted>;
  if (q.isError || !q.data) return <ErrorText>{errorMessage(q.error)}</ErrorText>;
  const p = q.data.payment;
  const who = p.customer ?? p.supplier;
  const whoPath = p.customer ? `/customers/${p.customer.id}` : p.supplier ? `/suppliers/${p.supplier.id}` : null;
  const docPath = (k: 'SALE' | 'RECEIPT', docId: string) => (k === 'SALE' ? `/sales/${docId}` : `/purchases/${docId}`);
  return (
    <>
      <p className="mb-2"><Link to="/payments">← Payments</Link></p>
      <PageTitle>{p.number} {p.status === 'VOIDED' ? <Badge tone="off">Cancelled</Badge> : <Badge tone="ok">Posted</Badge>}</PageTitle>
      <Card>
        <div className="text-sm text-muted">{p.partyType === 'CUSTOMER' ? 'Received from' : 'Paid to'}</div>
        <div className="text-lg font-semibold">{who ? (whoPath ? <Link to={whoPath}>{who.name}</Link> : who.name) : 'Walk-in customer'}</div>
        <div className="mt-2 text-2xl font-bold">{money(p.amount)} USD</div>
        <div className="text-muted">{p.partyType === 'CUSTOMER' ? 'into' : 'from'} {p.account.name} · {day(p.paidAt)}{p.reference ? ` · ref ${p.reference}` : ''}</div>
        {p.note && <p className="mt-2 whitespace-pre-line">{p.note}</p>}
      </Card>
      <SectionTitle>Settles</SectionTitle>
      <ul className="space-y-1">
        {p.allocations.map((a) => <li key={a.id}><Link to={docPath(a.document.kind, a.document.id)}>{a.document.number}</Link>: {money(a.amount)}</li>)}
      </ul>
      {can('payments.void') && p.status === 'POSTED' && (
        <div className="mt-5">
          {!open ? (
            <Button variant="ghost" onClick={() => setOpen(true)}>Cancel this payment</Button>
          ) : (
            <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!checkReason(reason)) cancel.mutate(); }} className="border-warn">
              <div className="font-semibold">Cancel this payment?</div>
              <Muted small>The money movement is reversed in the books and the {p.partyType === 'CUSTOMER' ? 'invoices' : 'bills'} it paid are open again. The payment stays on record as cancelled.</Muted>
              <Field label="Reason" error={reason ? checkReason(reason) : undefined} className="mt-3 block"><Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="mt-3 flex gap-2">
                <Button type="submit" variant="danger" disabled={!!checkReason(reason) || cancel.isPending}>Cancel payment</Button>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Back</Button>
              </div>
              {cancel.isError && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
            </Card>
          )}
        </div>
      )}
    </>
  );
}