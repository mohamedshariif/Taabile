import type { OpenDocument } from '../api/types';

// Pure helpers for the payment screens. The server decides and checks everything again; this only previews and spots mistakes.

const CENTS = /^\d{1,13}(\.\d{1,2})?$/;
export const checkPayAmount = (t: string): string | undefined => (CENTS.test(t.trim()) && Number(t) > 0 ? undefined : 'Enter an amount above zero (2 decimals at most)');

const toCents = (v: string): number => Math.round(Number(v) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

export interface Applied { id: string; number: string; amount: string; settles: boolean }

/**
 * What a payment would settle. With `only` (one chosen document) the whole amount goes there; otherwise the oldest
 * documents are paid first. `left` is whatever is more than is owed (the server refuses that).
 */
export function previewApply(amount: string, items: OpenDocument[], only?: string): { applied: Applied[]; left: string } {
  if (checkPayAmount(amount)) return { applied: [], left: '0.00' };
  let rest = toCents(amount);
  const pool = only ? items.filter((i) => i.id === only) : items;
  const applied: Applied[] = [];
  for (const d of pool) {
    if (rest <= 0) break;
    const owed = toCents(d.owed);
    const take = Math.min(rest, owed);
    applied.push({ id: d.id, number: d.number, amount: fromCents(take), settles: take === owed });
    rest -= take;
  }
  return { applied, left: fromCents(rest) };
}

export const totalOwed = (items: OpenDocument[]): string => fromCents(items.reduce((s, i) => s + toCents(i.owed), 0));

export interface PayDraft { partyId: string; accountId: string; amount: string; reference: string; note: string; only: string }

/** Everything that stops the Save button. */
export function payProblems(d: PayDraft, items: OpenDocument[], partyWord: 'customer' | 'supplier'): string[] {
  const out: string[] = [];
  if (!d.partyId) out.push(`Choose a ${partyWord}`);
  if (!d.accountId) out.push('Choose the cash drawer or bank account');
  const a = checkPayAmount(d.amount);
  if (a) out.push(a);
  else if (d.partyId) {
    const { left } = previewApply(d.amount, items, d.only || undefined);
    if (Number(left) > 0) out.push(d.only ? 'That is more than this document is owed' : `That is more than is owed (${totalOwed(items)}). Advance payments are not supported yet`);
  }
  return out;
}

/** The request. A chosen document goes as an explicit allocation; otherwise the server pays oldest first. */
export function payBody(d: PayDraft, kind: 'customer' | 'supplier') {
  return {
    ...(kind === 'customer' ? { customerId: d.partyId } : { supplierId: d.partyId }),
    financialAccountId: d.accountId,
    amount: d.amount.trim(),
    ...(d.reference.trim() ? { reference: d.reference.trim() } : {}),
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
    ...(d.only ? { allocations: [kind === 'customer' ? { saleId: d.only, amount: d.amount.trim() } : { receiptId: d.only, amount: d.amount.trim() }] } : {}),
  };
}