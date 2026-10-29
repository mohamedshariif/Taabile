import type { ProductSummary } from '../api/types';
import { checkPrice, checkQuantity, lineFactor, newLine, type DraftLine } from './stock';

// Pure helpers for the sales screens. The server works out the real prices and totals; this only builds the request
// and spots obvious mistakes so the seller sees them before pressing Sell.

export const PAYMENT_LABEL = { UNPAID: 'Not paid', PARTIAL: 'Part paid', PAID: 'Paid' } as const;
export const FULFILL_LABEL = { PENDING: 'Waiting for release', PARTIAL: 'Partly released', COMPLETE: 'Handed over' } as const;

export interface OtherPart { key: string; locationId: string; qty: string }
/** One line on the till: a product line plus any goods taken from other places. `price` is empty unless the seller changed it. */
export type SaleDraftLine = DraftLine & { other: OtherPart[] };
export interface PayDraft { key: string; accountId: string; amount: string }
export interface SaleDraft { locationId: string; customerId: string; lines: SaleDraftLine[]; payments: PayDraft[]; note: string }

export const newSaleLine = (p: ProductSummary): SaleDraftLine => {
  // Selling starts in the smallest unit that is for sale (the base unit), which is what counters sell by.
  const unit = p.units.find((u) => u.isBase) ?? p.units[0];
  return { ...newLine(p), unitId: unit?.id ?? '', other: [] };
};
export const newOther = (): OtherPart => ({ key: Math.random().toString(36).slice(2, 8), locationId: '', qty: '' });
export const newPay = (accountId = '', amount = ''): PayDraft => ({ key: Math.random().toString(36).slice(2, 8), accountId, amount });

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
export const checkPayment = (t: string): string | undefined => (AMOUNT.test(t.trim()) && Number(t) > 0 ? undefined : 'Enter an amount above zero (2 decimals at most)');

/** The request for both the live preview (/sales/quote) and the sale itself. */
export function quoteBody(d: SaleDraft) {
  return {
    locationId: d.locationId,
    ...(d.customerId ? { customerId: d.customerId } : {}),
    lines: d.lines.map((l) => ({
      productId: l.product.id,
      unitId: l.unitId,
      quantity: l.qty.trim(),
      ...(l.price.trim() ? { unitPrice: l.price.trim() } : {}),
      ...(l.other.some((o) => o.locationId) ? { fromOther: l.other.filter((o) => o.locationId).map((o) => ({ locationId: o.locationId, quantity: o.qty.trim() })) } : {}),
    })),
  };
}
export const saleBody = (d: SaleDraft) => ({
  ...quoteBody(d),
  payments: d.payments.filter((p) => p.accountId).map((p) => ({ financialAccountId: p.accountId, amount: p.amount.trim() })),
  ...(d.note.trim() ? { note: d.note.trim() } : {}),
});

/** True when every line is complete enough to ask the server for a price. */
export function readyToQuote(d: SaleDraft): boolean {
  return !!d.locationId && d.lines.length > 0 && d.lines.every((l) => !lineProblem(l)) ;
}

/** What is wrong with one line, in plain words (undefined = fine). */
export function lineProblem(l: SaleDraftLine): string | undefined {
  const q = checkQuantity(l.qty, l.product, l.unitId);
  if (q) return q;
  if (l.price.trim() && checkPrice(l.price)) return checkPrice(l.price);
  let other = 0;
  for (const o of l.other) {
    if (!o.locationId && !o.qty.trim()) continue;
    if (!o.locationId) return 'Choose which place the goods come from';
    const oq = checkQuantity(o.qty, l.product, l.unitId);
    if (oq) return oq;
    other += Number(o.qty);
  }
  if (other > Number(l.qty)) return 'More is taken from other places than is being sold';
  const seen = l.other.filter((o) => o.locationId).map((o) => o.locationId);
  if (new Set(seen).size !== seen.length) return 'The same place is listed twice';
  return undefined;
}

/** Everything that stops the Sell button, given the server's latest price quote (total as text, or null when unknown). */
export function saleProblems(d: SaleDraft, total: string | null, hasCustomerCredit: boolean): string[] {
  const out: string[] = [];
  if (!d.locationId) out.push('Choose where you are selling');
  if (d.lines.length === 0) out.push('Add at least one product');
  else if (d.lines.some((l) => lineProblem(l))) out.push('Fix the lines marked in red');
  const pays = d.payments.filter((p) => p.accountId || p.amount.trim());
  if (pays.some((p) => !p.accountId)) out.push('Choose where each payment goes');
  if (pays.some((p) => checkPayment(p.amount))) out.push('Fix the payment amounts');
  if (total !== null && !out.length) {
    const paid = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
    const owed = Math.round((Number(total) - paid) * 100) / 100;
    if (owed < 0) out.push('The payment is more than the total');
    if (owed > 0 && !d.customerId) out.push('Choose a customer to sell on credit, or take the full payment now');
    if (owed > 0 && d.customerId && !hasCustomerCredit) out.push('This customer cannot buy on credit: take the full payment now');
  }
  return out;
}

/** The sellable quantity in the unit chosen, for the "only N here" hint. */
export const baseToUnit = (baseQty: string, l: SaleDraftLine): number => Number(baseQty) / lineFactor(l);