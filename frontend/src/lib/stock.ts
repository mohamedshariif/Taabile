import type { MovementType, ProductSummary, ProductUnit } from '../api/types';
import { trimNumber } from './products';

// Pure helpers for the stock and purchasing screens (no React, no network).
// The server checks everything again and does the real maths; the numbers here are only a live preview.

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  OPENING: 'Opening stock',
  RECEIPT: 'Purchase received',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
  SALE_RELEASE: 'Released for sale',
  RETURN_IN: 'Customer return',
  RETURN_OUT: 'Returned to supplier',
  ADJUSTMENT: 'Adjustment',
  DAMAGE: 'Damaged / expired',
  REVERSAL: 'Reversal',
};

export const COST_LABEL = { FREIGHT: 'Freight', HANDLING: 'Handling', CONTAINER: 'Container', OTHER: 'Other' } as const;

const QTY = /^\d{1,14}(\.\d{1,4})?$/;
const PRICE = /^\d{1,13}(\.\d{1,4})?$/;
const COST = /^\d{1,13}(\.\d{1,6})?$/;
const num = (v: string): number => Number(v.trim());
const isWhole = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-9;

/** The unit a person chose, or the base unit when none is chosen. */
export const unitOf = (p: ProductSummary, unitId: string): ProductUnit | undefined =>
  p.units.find((u) => (unitId ? u.id === unitId : u.isBase));

/** Quantity typed in a chosen unit: more than 0, up to 4 decimals, and whole pieces when the product is counted that way. */
export function checkQuantity(text: string, product: ProductSummary, unitId: string): string | undefined {
  const t = text.trim();
  if (!QTY.test(t) || num(t) <= 0) return 'Enter a quantity above zero (up to 4 decimals)';
  const unit = unitOf(product, unitId);
  const base = num(t) * (unit ? num(unit.factor) : 1);
  if (!product.allowFractions && !isWhole(base)) return `${product.name} is counted in whole ${product.baseUnit}s`;
  return undefined;
}
/** A quantity that may be 0 (counting an empty shelf, sending none of a line). */
export function checkQuantityOrZero(text: string, product: ProductSummary, unitId: string): string | undefined {
  if (text.trim() !== '' && QTY.test(text.trim()) && num(text) === 0) return undefined;
  return checkQuantity(text, product, unitId);
}

export const checkPrice = (text: string): string | undefined => (PRICE.test(text.trim()) ? undefined : 'Enter a price with up to 4 decimals (0 is allowed)');
export const checkCost = (text: string): string | undefined => (COST.test(text.trim()) ? undefined : 'Enter a cost with up to 6 decimals (0 is allowed)');
export const checkAmount = (text: string): string | undefined => (PRICE.test(text.trim()) && num(text) > 0 ? undefined : 'Enter an amount above zero (up to 4 decimals)');
export const checkReason = (text: string): string | undefined => (text.trim().length >= 3 && text.trim().length <= 200 ? undefined : 'Give a reason (3 to 200 characters)');

const round = (n: number, places: number): number => Math.round((n + Number.EPSILON) * 10 ** places) / 10 ** places;

/** Preview of one receipt line's value: quantity x price, rounded to 4 decimals like the server. */
export const lineValue = (qty: string, price: string): number => (QTY.test(qty.trim()) && PRICE.test(price.trim()) ? round(num(qty) * num(price), 4) : 0);

export interface PreviewLine {
  qtyBase: number;
  value: number;
}
/**
 * Live preview of a receipt: goods total, landed costs shared by value (by quantity if everything is free),
 * and the resulting cost of one base unit per line. The server does the exact sharing when saving.
 */
export function previewReceipt(lines: PreviewLine[], costTotal: number) {
  const goods = round(lines.reduce((s, l) => s + l.value, 0), 4);
  const weights = goods > 0 ? lines.map((l) => l.value) : lines.map((l) => l.qtyBase);
  const sum = weights.reduce((s, w) => s + w, 0);
  const shares = lines.map((_, i) => (sum > 0 ? round((costTotal * weights[i]!) / sum, 4) : 0));
  const unitCosts = lines.map((l, i) => (l.qtyBase > 0 ? round((l.value + shares[i]!) / l.qtyBase, 6) : 0));
  return { goods, costs: round(costTotal, 4), total: round(goods + costTotal, 4), shares, unitCosts };
}

/** "2 x Sack 50 kg" lines for a stock row, or just the quantity when there are no packages. */
export function stockLine(onHand: string, baseUnit: string, packages: { name: string; quantity: string }[]): string {
  const base = `${trimNumber(onHand)} ${baseUnit}`;
  return packages.length ? `${base} (${packages.map((p) => `${trimNumber(p.quantity)} × ${p.name}`).join(' + ')})` : base;
}

/** Only manual entries can be undone from the movements screen. */
export const canReverse = (m: { type: MovementType; refType: string; reversed: boolean }): boolean =>
  !m.reversed && ['OPENING', 'ADJUSTMENT', 'DAMAGE'].includes(m.type) && ['OPENING', 'MANUAL'].includes(m.refType);

export const money = (v: string | null): string => (v === null ? '—' : formatMoney(v));
function formatMoney(v: string): string {
  const [w = '0', f = ''] = v.split('.');
  const t = f.replace(/0+$/, '');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${t.length < 2 ? t.padEnd(2, '0') : t}`;
}

// ── Lines on opening-stock and purchase forms ──
export interface DraftLine {
  key: string;
  product: ProductSummary;
  /** The unit the quantity is typed in (always a real unit id). */
  unitId: string;
  qty: string;
  /** Price (or cost) of ONE of the chosen unit. */
  price: string;
  /** Purchases only: arrived broken, not stocked. Empty = none. */
  damaged: string;
  /** Counts only: why the number differs (optional). */
  reason: string;
}

/** A new line starts in the product's purchase unit (for example the sack), else in its base unit. */
export function newLine(product: ProductSummary): DraftLine {
  const unit = product.units.find((u) => u.isPurchaseUnit && !u.isBase && u.status === 'ACTIVE') ?? product.units.find((u) => u.isBase);
  return {
    key: `${product.id}-${Math.random().toString(36).slice(2, 8)}`,
    product,
    unitId: unit?.id ?? '',
    qty: '',
    price: '',
    damaged: '',
    reason: '',
  };
}

export const lineFactor = (l: DraftLine): number => num(unitOf(l.product, l.unitId)?.factor ?? '1');
export const lineBaseQty = (l: DraftLine): number => (QTY.test(l.qty.trim()) ? round(num(l.qty) * lineFactor(l), 4) : 0);

export interface LineProblems {
  qty?: string;
  price?: string;
  damaged?: string;
}

export function lineProblems(l: DraftLine, priceCheck: (t: string) => string | undefined, allowZero = false): LineProblems {
  const p: LineProblems = {};
  const q = (allowZero ? checkQuantityOrZero : checkQuantity)(l.qty, l.product, l.unitId);
  if (q) p.qty = q;
  const pr = priceCheck(l.price);
  if (pr) p.price = pr;
  if (l.damaged.trim() !== '') {
    const d = checkQuantity(l.damaged, l.product, l.unitId);
    if (d) p.damaged = d;
  }
  return p;
}
export const linesHaveProblems = (lines: DraftLine[], priceCheck: (t: string) => string | undefined, allowZero = false): boolean =>
  lines.length === 0 || lines.some((l) => Object.keys(lineProblems(l, priceCheck, allowZero)).length > 0);

export function openingBody(locationId: string, lines: DraftLine[], note: string) {
  return {
    locationId,
    ...(note.trim() ? { note: note.trim() } : {}),
    lines: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.qty.trim(), unitCost: l.price.trim() })),
  };
}

export interface CostDraft {
  key: string;
  type: keyof typeof COST_LABEL;
  amount: string;
  note: string;
}
export interface ReceiptDraft {
  supplierId: string;
  locationId: string;
  receivedAt: string;
  supplierInvoiceRef: string;
  containerRef: string;
  invoiceDate: string;
  dueDate: string;
  note: string;
  lines: DraftLine[];
  costs: CostDraft[];
}

export function receiptBody(d: ReceiptDraft) {
  const opt = (k: string, v: string) => (v.trim() ? { [k]: v.trim() } : {});
  return {
    supplierId: d.supplierId,
    locationId: d.locationId,
    ...opt('receivedAt', d.receivedAt),
    ...opt('supplierInvoiceRef', d.supplierInvoiceRef),
    ...opt('containerRef', d.containerRef),
    ...opt('invoiceDate', d.invoiceDate),
    ...opt('dueDate', d.dueDate),
    ...opt('note', d.note),
    lines: d.lines.map((l) => ({
      productId: l.product.id,
      unitId: l.unitId,
      qtyReceived: l.qty.trim(),
      ...(l.damaged.trim() ? { qtyDamaged: l.damaged.trim() } : {}),
      unitPrice: l.price.trim(),
    })),
    costs: d.costs.map((c) => ({ type: c.type, amount: c.amount.trim(), ...(c.note.trim() ? { note: c.note.trim() } : {}) })),
  };
}

/** What stops a receipt from being saved yet, in plain words. Empty = ready. */
export function receiptProblems(d: ReceiptDraft, today: string): string[] {
  const out: string[] = [];
  if (!d.supplierId) out.push('Choose the supplier');
  if (!d.locationId) out.push('Choose where the goods arrived');
  if (linesHaveProblems(d.lines, checkPrice)) out.push(d.lines.length === 0 ? 'Add at least one product' : 'Fix the product lines marked in red');
  if (d.costs.some((c) => checkAmount(c.amount))) out.push('Fix the landed costs marked in red');
  if (d.receivedAt > today) out.push('The received date cannot be in the future');
  if (d.invoiceDate && d.dueDate && d.dueDate < d.invoiceDate) out.push('The due date is before the invoice date');
  return out;
}

export const adjustBody = (f: { locationId: string; product: ProductSummary; unitId: string; direction: 'IN' | 'OUT'; kind: 'ADJUSTMENT' | 'DAMAGE'; qty: string; reason: string }) => ({
  locationId: f.locationId,
  productId: f.product.id,
  unitId: f.unitId,
  direction: f.kind === 'DAMAGE' ? 'OUT' : f.direction,
  kind: f.kind,
  quantity: f.qty.trim(),
  reason: f.reason.trim(),
});


// ── Transfers and counts ──
export const TRANSFER_LABEL: Record<string, string> = {
  REQUESTED: 'Waiting for the sender',
  APPROVED: 'Approved, not sent yet',
  IN_TRANSIT: 'On its way',
  RECEIVED: 'Received',
  DISCREPANCY: 'Arrived short: needs a decision',
  CLOSED: 'Closed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};
export const COUNT_LABEL: Record<string, string> = { SUBMITTED: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Rejected' };

const noPrice = (): undefined => undefined;

export const transferBody = (fromLocationId: string, toLocationId: string, lines: DraftLine[], note: string) => ({
  fromLocationId,
  toLocationId,
  ...(note.trim() ? { note: note.trim() } : {}),
  lines: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, quantity: l.qty.trim() })),
});
export const transferProblems = (from: string, to: string, lines: DraftLine[]): string[] => {
  const out: string[] = [];
  if (!from) out.push('Choose where the goods come from');
  if (!to) out.push('Choose where they go');
  if (from && to && from === to) out.push('Choose two different places');
  if (linesHaveProblems(lines, noPrice)) out.push(lines.length === 0 ? 'Add at least one product' : 'Fix the lines marked in red');
  return out;
};

export const countBody = (locationId: string, lines: DraftLine[], note: string) => ({
  locationId,
  ...(note.trim() ? { note: note.trim() } : {}),
  lines: lines.map((l) => ({ productId: l.product.id, unitId: l.unitId, countedQty: l.qty.trim(), ...(l.reason.trim() ? { reason: l.reason.trim() } : {}) })),
});
export const countProblems = (locationId: string, lines: DraftLine[]): string[] => {
  const out: string[] = [];
  if (!locationId) out.push('Choose where you counted');
  if (linesHaveProblems(lines, noPrice, true)) out.push(lines.length === 0 ? 'Add at least one product' : 'Fix the lines marked in red');
  return out;
};

/** What was typed for receiving: only lines that differ from what was sent need to go to the server. */
export function receiveBody(sent: { productId: string; qtyDispatched: string }[], typed: Record<string, { qty: string; note: string }>) {
  const lines = sent
    .filter((l) => (typed[l.productId]?.qty.trim() ?? '') !== '' && Number(typed[l.productId]!.qty) !== Number(l.qtyDispatched))
    .map((l) => ({ productId: l.productId, quantity: typed[l.productId]!.qty.trim(), ...(typed[l.productId]!.note.trim() ? { note: typed[l.productId]!.note.trim() } : {}) }));
  return lines.length ? { lines } : {};
}
/** What stops a receive: a short line without a note, or more than was sent. */
export function receiveProblems(sent: { productId: string; qtyDispatched: string }[], typed: Record<string, { qty: string; note: string }>): string[] {
  const out: string[] = [];
  for (const l of sent) {
    const t = typed[l.productId];
    if (!t || t.qty.trim() === '') continue;
    if (!QTY.test(t.qty.trim())) out.push('Enter numbers only');
    else if (Number(t.qty) > Number(l.qtyDispatched)) out.push('You cannot receive more than was sent');
    else if (Number(t.qty) < Number(l.qtyDispatched) && t.note.trim().length < 3) out.push('Say what happened to the missing goods');
  }
  return [...new Set(out)];
}