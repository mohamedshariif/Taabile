import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../api/client';
import type { PartyPage, Receipt, Supplier } from '../../api/types';
import { Button, Card, ErrorText, Field, FieldRow, Input, Muted, PageTitle, SectionTitle, Select } from '../../components/ui';
import { trimNumber } from '../../lib/products';
import { checkAmount, checkPrice, COST_LABEL, lineBaseQty, lineValue, money, previewReceipt, receiptBody, receiptProblems, type CostDraft, type ReceiptDraft } from '../../lib/stock';
import { LinesEditor } from '../../features/stock/LinesEditor';
import { useIdempotencyKey, useLocations } from '../../features/stock/hooks';

const today = () => new Date().toISOString().slice(0, 10);
const newCost = (): CostDraft => ({ key: Math.random().toString(36).slice(2, 8), type: 'FREIGHT', amount: '', note: '' });

// Record goods arriving from a supplier. The preview shows what each unit will really cost once freight is shared in.
export function PurchaseNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { usable } = useLocations('purchases.manage');
  const suppliers = useQuery({ queryKey: ['suppliers', 'pick-active'], queryFn: () => api<PartyPage<Supplier>>('/suppliers?status=ACTIVE&limit=100') });
  const [d, setD] = useState<ReceiptDraft>({ supplierId: '', locationId: '', receivedAt: today(), supplierInvoiceRef: '', containerRef: '', invoiceDate: '', dueDate: '', note: '', lines: [], costs: [] });
  const set = (patch: Partial<ReceiptDraft>) => setD((x) => ({ ...x, ...patch }));
  useEffect(() => {
    if (!d.locationId && usable.length === 1) setD((x) => ({ ...x, locationId: usable[0]!.id }));
  }, [usable, d.locationId]);

  const keyFor = useIdempotencyKey();
  const save = useMutation({
    mutationFn: () => {
      const body = receiptBody(d);
      return api<{ receipt: Receipt }>('/purchases', { method: 'POST', body, idempotencyKey: keyFor(body) });
    },
    onSuccess: (r) => {
      for (const k of ['purchases', 'stock', 'stock-movements', 'suppliers']) void qc.invalidateQueries({ queryKey: [k] });
      navigate(`/purchases/${r.receipt.id}`);
    },
  });

  const costTotal = d.costs.reduce((s, c) => s + (checkAmount(c.amount) ? 0 : Number(c.amount)), 0);
  const preview = previewReceipt(d.lines.map((l) => ({ qtyBase: lineBaseQty(l), value: lineValue(l.qty, l.price) })), costTotal);
  const problems = receiptProblems(d, today());
  const updateCost = (key: string, patch: Partial<CostDraft>) => set({ costs: d.costs.map((c) => (c.key === key ? { ...c, ...patch } : c)) });

  return (
    <>
      <p className="mb-2"><Link to="/purchases">← Purchases</Link></p>
      <PageTitle>Record a purchase</PageTitle>
      <Muted>Goods that arrived from a supplier. Stock goes up, and what you owe the supplier goes up. This cannot be edited afterwards; a mistake is cancelled and entered again.</Muted>

      <Card as="form" onSubmit={(e) => { e.preventDefault(); if (!problems.length) save.mutate(); }}>
        <FieldRow>
          <Field label="Supplier">
            <Select value={d.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
              <option value="">Choose a supplier</option>
              {(suppliers.data?.items ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Where did it arrive?">
            <Select value={d.locationId} onChange={(e) => set({ locationId: e.target.value })}>
              <option value="">Choose a place</option>
              {usable.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </Field>
          <Field label="Date received" error={d.receivedAt > today() ? 'Cannot be in the future' : undefined}>
            <Input type="date" value={d.receivedAt} max={today()} onChange={(e) => set({ receivedAt: e.target.value })} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Supplier invoice number (optional)" hint="The same invoice cannot be entered twice.">
            <Input value={d.supplierInvoiceRef} maxLength={60} onChange={(e) => set({ supplierInvoiceRef: e.target.value })} />
          </Field>
          <Field label="Container (optional)">
            <Input value={d.containerRef} maxLength={60} onChange={(e) => set({ containerRef: e.target.value })} />
          </Field>
          <Field label="Invoice date (optional)">
            <Input type="date" value={d.invoiceDate} onChange={(e) => set({ invoiceDate: e.target.value })} />
          </Field>
          <Field label="Due date (optional)" error={d.invoiceDate && d.dueDate && d.dueDate < d.invoiceDate ? 'Before the invoice date' : undefined}>
            <Input type="date" value={d.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
          </Field>
        </FieldRow>

        <SectionTitle>What arrived</SectionTitle>
        <LinesEditor lines={d.lines} onChange={(lines) => set({ lines })} priceLabel="Price of one unit" priceHint="What the supplier charges for one of this unit." priceCheck={checkPrice} withDamaged />

        <SectionTitle>Freight, container and other costs</SectionTitle>
        <Muted small>These are added to the cost of the goods, shared by value. They are added to what you owe the supplier.</Muted>
        <ul className="mt-2 space-y-2">
          {d.costs.map((c) => (
            <li key={c.key} className="grid gap-2 sm:grid-cols-[10rem_10rem_minmax(0,1fr)_auto] sm:items-end">
              <Field label="Kind">
                <Select value={c.type} onChange={(e) => updateCost(c.key, { type: e.target.value as CostDraft['type'] })}>
                  {(Object.keys(COST_LABEL) as CostDraft['type'][]).map((t) => <option key={t} value={t}>{COST_LABEL[t]}</option>)}
                </Select>
              </Field>
              <Field label="Amount" error={c.amount ? checkAmount(c.amount) : undefined}>
                <Input value={c.amount} inputMode="decimal" onChange={(e) => updateCost(c.key, { amount: e.target.value })} />
              </Field>
              <Field label="Note (optional)">
                <Input value={c.note} maxLength={120} onChange={(e) => updateCost(c.key, { note: e.target.value })} />
              </Field>
              <Button variant="link" className="min-h-11" onClick={() => set({ costs: d.costs.filter((x) => x.key !== c.key) })}>Remove</Button>
            </li>
          ))}
        </ul>
        {d.costs.length < 10 && <Button variant="ghost" small className="mt-2" onClick={() => set({ costs: [...d.costs, newCost()] })}>Add a cost</Button>}

        {d.lines.length > 0 && (
          <div className="mt-5 rounded-lg bg-page p-3">
            <div className="font-semibold">Preview</div>
            <ul className="mt-1 space-y-1 text-sm">
              {d.lines.map((l, i) => (
                <li key={l.key}>
                  {l.product.name}: {money(String(preview.unitCosts[i] ?? 0))} per {l.product.baseUnit}
                  {lineBaseQty(l) > 0 ? ` (${trimNumber(String(lineBaseQty(l)))} ${l.product.baseUnit})` : ''}
                </li>
              ))}
            </ul>
            <div className="mt-2 text-sm">
              Goods {money(String(preview.goods))} + costs {money(String(preview.costs))} = <span className="font-semibold">we owe {money(String(preview.total))}</span>
            </div>
            <Muted small>This is a preview. The server does the exact sharing when you save.</Muted>
          </div>
        )}

        <Field label="Note (optional)" className="mt-4 block">
          <Input value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {problems.length > 0 && d.lines.length > 0 && <Muted small className="mt-3">{problems.join('. ')}.</Muted>}
        <div className="mt-4">
          <Button type="submit" disabled={problems.length > 0 || save.isPending}>{save.isPending ? 'Saving…' : 'Save purchase'}</Button>
        </div>
        {save.isError && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      </Card>
    </>
  );
}