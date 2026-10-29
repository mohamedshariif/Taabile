import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { Customer, PartyPage, Sale, SaleQuote } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ProductPicker } from '../../components/ProductPicker';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { baseToUnit, lineProblem, newOther, newPay, newSaleLine, quoteBody, readyToQuote, saleBody, saleProblems, checkPayment, type SaleDraft, type SaleDraftLine } from '../../lib/sales';
import { money } from '../../lib/stock';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

// The till. Pick products, see the real price and total as you go, say how much was paid, and press Sell.
// What is not paid is owed by a named customer (credit). The server works out the exact figures and checks everything again.
export function SaleNewPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { all, usable } = useLocations('sales.create');
  const [d, setD] = useState<SaleDraft>({ locationId: '', customerId: '', lines: [], payments: [], note: '' });
  const set = (patch: Partial<SaleDraft>) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (!d.locationId && usable.length === 1) setD((x) => ({ ...x, locationId: usable[0]!.id }));
  }, [usable, d.locationId]);

  const customers = useQuery({ queryKey: ['customers', 'pick-active'], queryFn: () => api<PartyPage<Customer>>('/customers?status=ACTIVE&limit=100'), enabled: can('customers.view') });
  const customer = customers.data?.items.find((c) => c.id === d.customerId);
  const accounts = useQuery({
    queryKey: ['sale-accounts', d.locationId],
    queryFn: () => api<{ accounts: { id: string; name: string; type: 'CASH' | 'BANK' }[] }>(`/sales/payment-accounts?locationId=${d.locationId}`),
    enabled: !!d.locationId,
  });

  const quoteReq = readyToQuote(d) ? quoteBody(d) : null;
  const quote = useQuery({
    queryKey: ['sale-quote', quoteReq],
    queryFn: () => api<SaleQuote>('/sales/quote', { method: 'POST', body: quoteReq! }),
    enabled: !!quoteReq,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const q = quoteReq ? quote.data : undefined;
  const total = q ? q.total : null;

  const updateLine = (key: string, patch: Partial<SaleDraftLine>) => set({ lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const otherPlaces = all.filter((l) => l.status === 'ACTIVE' && l.id !== d.locationId);
  const problems = saleProblems(d, total, !!customer && customer.creditLimit !== null);
  const paid = d.payments.reduce((s, p) => s + (checkPayment(p.amount) ? 0 : Number(p.amount)), 0);
  const owed = total === null ? null : Math.round((Number(total) - paid) * 100) / 100;
  const lineBlocked = q?.lines.some((l) => l.problem);

  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = saleBody(d);
      return api<{ sale: Sale }>('/sales', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      for (const k of ['sales', 'stock', 'stock-movements', 'money-accounts', 'customers', 'pending-release']) void qc.invalidateQueries({ queryKey: [k] });
      navigate(`/sales/${r.sale.id}`);
    },
  });

  const fullPayment = () => {
    const accts = accounts.data?.accounts ?? [];
    const first = accts.find((a) => a.type === 'CASH') ?? accts[0];
    if (first && total !== null) set({ payments: [newPay(first.id, Number(total).toFixed(2))] });
  };

  return (
    <>
      <p className="mb-2"><Link to="/sales">← Sales</Link></p>
      <PageTitle>New sale</PageTitle>
      <Muted>The price comes from the price list. The stock leaves when the goods are handed over.</Muted>

      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length && !lineBlocked) save.mutate(); }}>
        <FieldRow>
          <Field label="Selling from">
            <Select value={d.locationId} onChange={(e) => set({ locationId: e.target.value, payments: [] })}>
              <option value="">Choose a place</option>
              {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          {can('customers.view') && (
            <Field label="Customer" hint={customer ? (customer.creditLimit === null ? 'Cash only: no credit.' : `Credit limit ${money(customer.creditLimit)}, owes ${money(customer.balance)}`) : 'Leave empty for a walk-in customer.'}>
              <Select value={d.customerId} onChange={(e) => set({ customerId: e.target.value })}>
                <option value="">Walk-in customer</option>
                {(customers.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
        </FieldRow>

        <SectionTitle>Products</SectionTitle>
        <ul className="space-y-3">
          {d.lines.map((l, i) => {
            const ql = q?.lines[i];
            const problem = lineProblem(l);
            return (
              <li key={l.key} className="rounded-lg border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{l.product.name}</div>
                    <div className="text-sm text-muted">{l.product.sku}</div>
                  </div>
                  <Button variant="link" className="min-h-9" onClick={() => set({ lines: d.lines.filter((x) => x.key !== l.key) })}>Remove</Button>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
                  <Field label="Unit">
                    <Select value={l.unitId} onChange={(e) => updateLine(l.key, { unitId: e.target.value })}>
                      {l.product.units.filter((u) => u.status === 'ACTIVE' && u.isSaleUnit).map((u) => (
                        <option key={u.id} value={u.id}>{u.name}{u.isBase ? '' : ` (${trimNumber(u.factor)} ${l.product.baseUnit})`}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Quantity" error={l.qty ? problem : undefined}>
                    <Input value={l.qty} inputMode="decimal" onChange={(e) => updateLine(l.key, { qty: e.target.value })} />
                  </Field>
                  {can('sales.discount') ? (
                    <Field label="Price (change only to give a discount)" hint={ql?.listPrice ? `List price ${money(ql.listPrice)}` : undefined}>
                      <Input value={l.price} inputMode="decimal" placeholder={ql?.listPrice ? money(ql.listPrice) : ''} onChange={(e) => updateLine(l.key, { price: e.target.value })} />
                    </Field>
                  ) : (
                    <div className="self-end pb-2 text-sm"><span className="text-muted">Price </span><span className="font-semibold">{ql?.unitPrice ? money(ql.unitPrice) : '—'}</span></div>
                  )}
                  <div className="self-end pb-2 text-right">
                    <div className="text-sm text-muted">Line total</div>
                    <div className="text-lg font-bold">{ql ? money(ql.lineTotal) : '—'}</div>
                  </div>
                </div>
                {ql?.problem && <ErrorText>{ql.problem}. Ask the Admin to set a price.</ErrorText>}
                {ql?.belowCost && <ErrorText>This price is below cost{can('sales.void') ? '. Only the Admin can sell below cost.' : '.'}</ErrorText>}
                {ql?.parts.filter((p) => !p.enough).map((p) => (
                  <ErrorText key={p.locationId}>Only {trimNumber(String(baseToUnit(p.available, l)))} {l.product.units.find((u) => u.id === l.unitId)?.name} available at {p.locationName}.</ErrorText>
                ))}
                {can('sales.supply_other_location') && (
                  <div className="mt-2">
                    {l.other.map((o) => (
                      <div key={o.key} className="mt-2 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
                        <Field label="Also taken from">
                          <Select value={o.locationId} onChange={(e) => updateLine(l.key, { other: l.other.map((x) => (x.key === o.key ? { ...x, locationId: e.target.value } : x)) })}>
                            <option value="">Choose a place</option>
                            {otherPlaces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </Select>
                        </Field>
                        <Field label="How much">
                          <Input value={o.qty} inputMode="decimal" onChange={(e) => updateLine(l.key, { other: l.other.map((x) => (x.key === o.key ? { ...x, qty: e.target.value } : x)) })} />
                        </Field>
                        <Button variant="link" className="min-h-11" onClick={() => updateLine(l.key, { other: l.other.filter((x) => x.key !== o.key) })}>Remove</Button>
                      </div>
                    ))}
                    {l.other.length < 5 && <Button variant="ghost" small className="mt-2" onClick={() => updateLine(l.key, { other: [...l.other, newOther()] })}>Take some from another place</Button>}
                    {l.other.length > 0 && <Muted small className="mt-1">The rest comes from {all.find((x) => x.id === d.locationId)?.name ?? 'here'}. Goods from other places stay there until that place releases them.</Muted>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-3"><ProductPicker exclude={d.lines.map((l) => l.product.id)} onPick={(p) => set({ lines: [...d.lines, newSaleLine(p)] })} /></div>
        {quote.isError && <ErrorText>{errorMessage(quote.error)}</ErrorText>}

        {d.lines.length > 0 && (
          <>
            <SectionTitle>Payment</SectionTitle>
            <ul className="space-y-2">
              {d.payments.map((p) => (
                <li key={p.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                  <Field label="Paid into">
                    <Select value={p.accountId} onChange={(e) => set({ payments: d.payments.map((x) => (x.key === p.key ? { ...x, accountId: e.target.value } : x)) })}>
                      <option value="">Choose an account</option>
                      {(accounts.data?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Amount" error={p.amount ? checkPayment(p.amount) : undefined}>
                    <Input value={p.amount} inputMode="decimal" onChange={(e) => set({ payments: d.payments.map((x) => (x.key === p.key ? { ...x, amount: e.target.value } : x)) })} />
                  </Field>
                  <Button variant="link" className="min-h-11" onClick={() => set({ payments: d.payments.filter((x) => x.key !== p.key) })}>Remove</Button>
                </li>
              ))}
            </ul>
            {accounts.data && accounts.data.accounts.length === 0 && <Muted small>There is no cash drawer for this place yet. Ask the Admin to add one under Cash and bank, or sell on credit.</Muted>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" small disabled={total === null || !accounts.data?.accounts.length} onClick={fullPayment}>Take the full payment</Button>
              {d.payments.length < 5 && <Button variant="ghost" small disabled={!accounts.data?.accounts.length} onClick={() => set({ payments: [...d.payments, newPay()] })}>Add a payment</Button>}
            </div>

            <div className="mt-5 rounded-lg bg-page p-3">
              <div className="flex justify-between"><span>Subtotal</span><span>{q ? money(q.subtotal) : '—'}</span></div>
              {q && Number(q.discountTotal) > 0 && <div className="flex justify-between"><span>Discount</span><span>−{money(q.discountTotal)}</span></div>}
              {q && Number(q.taxTotal) > 0 && <div className="flex justify-between"><span>Tax ({trimNumber(q.taxRate)}%)</span><span>{money(q.taxTotal)}</span></div>}
              <div className="mt-1 flex justify-between text-xl font-bold"><span>Total (USD)</span><span>{q ? money(q.total) : '—'}</span></div>
              <div className="flex justify-between"><span>Paid now</span><span>{money(paid.toFixed(2))}</span></div>
              {owed !== null && owed > 0 && <div className="flex justify-between font-semibold text-warn"><span>On credit (owed by the customer)</span><span>{money(owed.toFixed(2))}</span></div>}
              <Muted small className="mt-1">Prices shown are exact. The server checks stock, credit and prices again when you press Sell.</Muted>
            </div>
          </>
        )}

        <Field label="Note (optional)" className="mt-4 block">
          <Input value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {problems.length > 0 && d.lines.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4">
          <Button type="submit" disabled={problems.length > 0 || !!lineBlocked || total === null || save.isPending}>{save.isPending ? 'Saving…' : 'Sell'}</Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}