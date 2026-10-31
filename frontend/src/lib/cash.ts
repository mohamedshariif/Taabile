import type { CashChoice, CashTransfer } from '../api/types';

// Pure helpers for the expense and cash movement screens. The server checks everything again.

const CENTS = /^\d{1,13}(\.\d{1,2})?$/;
export const checkAmount2 = (t: string): string | undefined => (CENTS.test(t.trim()) && Number(t) > 0 ? undefined : 'Enter an amount above zero (2 decimals at most)');
/** An amount that may be zero (an empty drawer was counted). */
export const checkCounted = (t: string): string | undefined => (CENTS.test(t.trim()) ? undefined : 'Enter the amount you counted (0 is allowed, 2 decimals at most)');
export const checkNote = (t: string): string | undefined => (t.trim().length >= 3 && t.trim().length <= 200 ? undefined : 'Write 3 to 200 characters');

export const TRANSFER_LABEL: Record<CashTransfer['type'], string> = {
  DEPOSIT: 'Deposit to bank',
  HANDOVER: 'Cash handover',
  WITHDRAWAL: 'Bank withdrawal',
  TRANSFER: 'Bank transfer',
};

/** What kind of movement a pair of accounts makes (the server decides the same way). */
export function transferKind(from: CashChoice | undefined, to: CashChoice | undefined): CashTransfer['type'] | null {
  if (!from || !to) return null;
  if (from.type === 'CASH') return to.type === 'BANK' ? 'DEPOSIT' : 'HANDOVER';
  return to.type === 'CASH' ? 'WITHDRAWAL' : 'TRANSFER';
}
/** Cash leaving a drawer waits for the other side to confirm. */
export const needsConfirmation = (kind: CashTransfer['type'] | null): boolean => kind === 'DEPOSIT' || kind === 'HANDOVER';

export interface ExpenseDraft { categoryId: string; amount: string; description: string; accountId: string; locationId: string; date: string }
export function expenseProblems(d: ExpenseDraft, needsPlace: boolean): string[] {
  const out: string[] = [];
  if (!d.categoryId) out.push('Choose what kind of cost it is');
  if (checkAmount2(d.amount)) out.push(checkAmount2(d.amount)!);
  if (d.description.trim().length < 3) out.push('Say what it was for (at least 3 characters)');
  if (!d.accountId) out.push('Choose where the money comes from');
  if (needsPlace && !d.locationId) out.push('Choose which place this cost belongs to');
  return out;
}
export const expenseBody = (d: ExpenseDraft) => ({
  categoryId: d.categoryId,
  amount: d.amount.trim(),
  description: d.description.trim(),
  financialAccountId: d.accountId,
  ...(d.locationId ? { locationId: d.locationId } : {}),
  ...(d.date ? { incurredOn: d.date } : {}),
});

export interface MoveDraft { fromId: string; toId: string; amount: string; note: string }
export function moveProblems(d: MoveDraft): string[] {
  const out: string[] = [];
  if (!d.fromId) out.push('Choose where the money comes from');
  if (!d.toId) out.push('Choose where it goes');
  if (d.fromId && d.fromId === d.toId) out.push('Choose two different accounts');
  if (checkAmount2(d.amount)) out.push(checkAmount2(d.amount)!);
  if (d.note.trim() && checkNote(d.note)) out.push(checkNote(d.note)!);
  return out;
}
export const moveBody = (d: MoveDraft) => ({ fromAccountId: d.fromId, toAccountId: d.toId, amount: d.amount.trim(), ...(d.note.trim() ? { note: d.note.trim() } : {}) });

/** Confirming: the amount that really arrived, and a note when it differs from what was sent. */
export function confirmProblems(sent: string, received: string, note: string): string[] {
  const t = received.trim();
  if (t === '') return [];
  if (checkCounted(t)) return [checkCounted(t)!];
  if (Math.round(Number(t) * 100) !== Math.round(Number(sent) * 100) && checkNote(note)) return ['The amount differs from what was sent: write a short note saying why'];
  return [];
}
export const confirmBody = (received: string, note: string) => ({
  ...(received.trim() ? { receivedAmount: received.trim() } : {}),
  ...(note.trim() ? { differenceNote: note.trim() } : {}),
});