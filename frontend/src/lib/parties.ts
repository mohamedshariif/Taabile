import type { Customer, Supplier } from '../api/types';
import { formatPrice } from './products';

// Pure helpers for the customer and supplier screens (no React, no network).
// The server checks everything again; these checks only give instant, friendly feedback while typing.

export type PartyKind = 'customer' | 'supplier';

/** "+211 912-345-678" -> "+211912345678" (the same clean-up the server does). */
export const normalizePhone = (v: string): string => v.trim().replace(/[\s\-().]/g, '');

export interface PartyDraft {
  name: string;
  code: string;
  phone: string;
  address: string;
  priceListId: string;
  creditLimit: string; // empty = cash only
  paymentTermsDays: string;
}
export interface PartyProblems {
  name?: string;
  code?: string;
  phone?: string;
  creditLimit?: string;
  paymentTermsDays?: string;
}

export const emptyParty = (): PartyDraft => ({ name: '', code: '', phone: '', address: '', priceListId: '', creditLimit: '', paymentTermsDays: '0' });

export const draftFrom = (p: Customer | Supplier): PartyDraft => ({
  name: p.name,
  code: p.code,
  phone: p.phone ?? '',
  address: p.address ?? '',
  priceListId: 'priceList' in p ? (p.priceList?.id ?? '') : '',
  creditLimit: 'creditLimit' in p && p.creditLimit ? formatPrice(p.creditLimit) : '',
  paymentTermsDays: String(p.paymentTermsDays),
});

export function validateParty(d: PartyDraft): PartyProblems {
  const out: PartyProblems = {};
  if (d.name.trim().length < 2 || d.name.trim().length > 120) out.name = 'Enter a name (2 to 120 characters)';
  if (d.code.trim() && !/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(d.code.trim().toUpperCase())) out.code = 'Up to 30 letters, numbers, . _ or - (or leave empty)';
  if (d.phone.trim() && !/^\+?\d{6,15}$/.test(normalizePhone(d.phone))) out.phone = 'Use 6 to 15 digits, a leading + is fine';
  const credit = d.creditLimit.trim();
  if (credit && !/^\d{1,13}(\.\d{1,4})?$/.test(credit)) out.creditLimit = 'Use a number with up to 4 decimals, or leave empty for cash only';
  const days = d.paymentTermsDays.trim();
  if (!/^\d{1,3}$/.test(days) || Number(days) > 365) out.paymentTermsDays = 'A whole number of days, 0 to 365';
  return out;
}
export const hasProblems = (p: PartyProblems): boolean => Object.keys(p).length > 0;

/** Request body for a customer. Credit fields are only sent by people allowed to manage credit (the server refuses them otherwise). */
export function customerBody(d: PartyDraft, canCredit: boolean) {
  return {
    name: d.name.trim(),
    ...(d.code.trim() ? { code: d.code.trim().toUpperCase() } : {}),
    phone: d.phone.trim() ? normalizePhone(d.phone) : null,
    address: d.address.trim() || null,
    priceListId: d.priceListId || null,
    ...(canCredit ? { creditLimit: d.creditLimit.trim() || null, paymentTermsDays: Number(d.paymentTermsDays) } : {}),
  };
}

export function supplierBody(d: PartyDraft) {
  return {
    name: d.name.trim(),
    ...(d.code.trim() ? { code: d.code.trim().toUpperCase() } : {}),
    phone: d.phone.trim() ? normalizePhone(d.phone) : null,
    address: d.address.trim() || null,
    paymentTermsDays: Number(d.paymentTermsDays),
  };
}

/** Only what differs from the saved record, so a save sends just the changes (and an unchanged form sends nothing). */
export function changedFields(body: Record<string, unknown>, saved: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([k, v]) => (v ?? null) !== (saved[k] ?? null)));
}

/** The saved record in the same shape as the request body, for comparing with `changedFields`. */
export function savedAsBody(p: Customer | Supplier, canCredit: boolean): Record<string, unknown> {
  return 'priceList' in p
    ? { name: p.name, code: p.code, phone: p.phone, address: p.address, priceListId: p.priceList?.id ?? null, ...(canCredit ? { creditLimit: p.creditLimit ? formatPrice(p.creditLimit) : null, paymentTermsDays: p.paymentTermsDays } : {}) }
    : { name: p.name, code: p.code, phone: p.phone, address: p.address, paymentTermsDays: p.paymentTermsDays };
}

/** "Owes us 250.75 USD", "We owe 1,200.00 USD" or "Settled". */
export function describeBalance(kind: PartyKind, balance: string, currency: string): string {
  const n = Number(balance);
  if (n === 0) return 'Settled';
  const amount = `${formatPrice(balance.replace('-', ''))} ${currency}`;
  if (kind === 'customer') return n > 0 ? `Owes us ${amount}` : `We owe them ${amount}`;
  return n > 0 ? `We owe ${amount}` : `They owe us ${amount}`;
}

export const creditText = (limit: string | null, days: number): string =>
  limit === null ? 'Cash only' : `Up to ${formatPrice(limit)}${days > 0 ? `, pays within ${days} days` : ''}`;