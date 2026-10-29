import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Customer, OpenDocuments, PartyPage, PaymentRecord, Supplier } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select } from '../../components/ui';
import { payBody, payProblems, previewApply, totalOwed, type PayDraft } from '../../lib/payments';
import { money } from '../../lib/stock';
import { day } from '../purchases/PurchasesPage';
import { useIdempotencyKey } from '../../features/stock/hooks';

// Taking money from a customer, or paying a supplier. The money is matched to the oldest unpaid invoices (or bills)
// unless one is chosen. A payment can never be more than what is owed.
export function PaymentFormPage({ kind }: { kind: 'customer' | 'supplier' }) {
  const isCustomer = kind === 'customer';
  const word = isCustomer ? 'customer' : 'supplier';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [d, setD] = useState<PayDraft>({ partyId: params.get(isCustomer ? 'customerId' : 'supplierId') ?? '', accountId: '', amount: '', reference: '', note: '', only: '' });
  const set = (patch: Partial<PayDraft>) => setD((x) => ({ ...x, ...patch }));

  const parties = useQuery({
    queryKey: [isCustomer ? 'customers' : 'suppliers', 'pick-all'],
    queryFn: () => api<PartyPage<Customer | Supplier>>(`/${isCustomer ? 'customers' : 'suppliers'}?limit=100`),
  });
  const accounts = useQuery({ queryKey: ['payment-accounts'], queryFn: () => api<{ accounts: { id: string; name: string; type: 'CASH' | 'BANK' }[] }>('/payments/accounts') });
  const open = useQuery({
    queryKey: ['payments-open', kind, d.partyId],
    queryFn: () => api<OpenDocuments>(`/payments/open?${isCustomer ? 'customerId' : 'supplierId'}=${d.partyId}`),
    enabled: !!d.partyId,
  });
  const items = open.data?.items ?? [];
  const problems = payProblems(d, items, word);
  const { applied } = previewApply(d.amount, items, d.only || undefined);

  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = payBody(d, kind);
      return api<{ payment: PaymentRecord }>(isCustomer ? '/payments/receive' : '/payments/pay-supplier', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      for (const k of ['payments', 'payments-open', 'customers', 'suppliers', 'sales', 'sale', 'purchases', 'purchase', 'money-accounts']) void qc.invalidateQueries({ queryKey: [k] });
      navigate(`/payments/${r.payment.id}`);
    },
  });

  return (
    <>
      <p className="mb-2"><Link to="/payments">← Payments</Link></p>
      <PageTitle>{isCustomer ? 'Take payment from a customer' : 'Pay a supplier'}</PageTitle>
      <Muted>{isCustomer ? 'Money in. It pays the oldest unpaid invoices first.' : 'Money out. It pays the oldest unpaid bills first.'}</Muted>
      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
        <FieldRow>
          <Field label={isCustomer ? 'Customer' : 'Supplier'}>
            <Select value={d.partyId} onChange={(e) => set({ partyId: e.target.value, only: '', amount: '' })}>
              <option value="">Choose a {word}</option>
              {(parties.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label={isCustomer ? 'Paid into' : 'Paid from'}>
            <Select value={d.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              <option value="">Choose an account</option>
              {(accounts.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        </FieldRow>

        {d.partyId && open.isLoading && <Muted>Loading…</Muted>}
        {open.isError && <ErrorText>{errorMessage(open.error)}</ErrorText>}
        {open.data && (
          <>
            <SectionTitle>{isCustomer ? 'Unpaid invoices' : 'Unpaid bills'}</SectionTitle>
            {items.length === 0 ? (
              <Muted>{isCustomer ? 'This customer owes nothing on any invoice.' : 'Nothing is owed to this supplier on any bill.'}</Muted>
            ) : (
              <ul className="space-y-2">
                {items.map((i) => {
                  const chosen = d.only === i.id;
                  return (
                    <li key={i.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 ${chosen ? 'border-brand' : 'border-line'}`}>
                      <div>
                        <div className="font-semibold">{i.number}</div>
                        <div className="text-sm text-muted">{day(i.date)}{i.dueDate ? ` · due ${day(i.dueDate)}` : ''}{i.overdue ? ' · overdue' : ''}</div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold">{money(i.owed)}</span>
                        <Button type="button" small variant="ghost" onClick={() => set({ only: chosen ? '' : i.id, amount: chosen ? d.amount : Number(i.owed).toFixed(2) })}>{chosen ? 'Pay oldest first' : 'Pay only this'}</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {items.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <Muted small>Total owed: {money(totalOwed(items))}</Muted>
                <Button type="button" small variant="ghost" onClick={() => set({ only: '', amount: totalOwed(items) })}>Pay everything</Button>
              </div>
            )}
          </>
        )}

        <FieldRow>
          <Field label="Amount (USD)"><Input value={d.amount} inputMode="decimal" onChange={(e) => set({ amount: e.target.value })} /></Field>
          <Field label="Reference (optional)" hint="Transfer or cheque number"><Input value={d.reference} maxLength={80} onChange={(e) => set({ reference: e.target.value })} /></Field>
        </FieldRow>
        <Field label="Note (optional)" className="block"><Input value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} /></Field>

        {applied.length > 0 && (
          <div className="mt-4 rounded-lg bg-page p-3">
            <div className="font-semibold">This payment will settle</div>
            <ul>{applied.map((a) => <li key={a.id}>{a.number}: {money(a.amount)} {a.settles ? '(paid in full)' : '(part)'}</li>)}</ul>
          </div>
        )}
        {d.amount.trim() !== '' && problems.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4"><Button type="submit" disabled={problems.length > 0 || save.isPending}>{save.isPending ? 'Saving…' : isCustomer ? 'Take payment' : 'Pay supplier'}</Button></div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}