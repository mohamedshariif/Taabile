// Posting rules: each business event becomes one balanced journal entry.
// These are pure functions. They return a draft; the service layer resolves account
// selectors to account ids and inserts the entry in the same transaction as the event.
// A sale is NOT money received: a cash sale is a sale entry plus a payment entry.

import { D, ZERO, storeMoney, type Numeric } from '../shared/money.js';
import type { Decimal } from 'decimal.js';
import type { SystemKey } from './chart.js';

export type AccountSelector = { key: SystemKey } | { id: string };

export interface DraftLine {
  account: AccountSelector;
  debit: Decimal;
  credit: Decimal;
  locationId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  employeeId?: string | null;
  memo?: string;
}

export interface JournalDraft {
  sourceType: string;
  description: string;
  lines: DraftLine[];
}

type Dims = Pick<DraftLine, 'locationId' | 'customerId' | 'supplierId' | 'employeeId' | 'memo'>;

const dr = (account: AccountSelector, amount: Numeric, dims: Dims = {}): DraftLine => ({
  account,
  debit: storeMoney(amount),
  credit: ZERO,
  ...dims,
});
const cr = (account: AccountSelector, amount: Numeric, dims: Dims = {}): DraftLine => ({
  account,
  debit: ZERO,
  credit: storeMoney(amount),
  ...dims,
});
const key = (k: SystemKey): AccountSelector => ({ key: k });
const acct = (id: string): AccountSelector => ({ id });

function draft(sourceType: string, description: string, lines: DraftLine[]): JournalDraft {
  // Zero-value lines are dropped (for example a sale with no tax).
  const real = lines.filter((l) => l.debit.gt(0) || l.credit.gt(0));
  assertBalanced({ sourceType, description, lines: real });
  return { sourceType, description, lines: real };
}

export function totals(d: JournalDraft): { debit: Decimal; credit: Decimal } {
  return d.lines.reduce(
    (t, l) => ({ debit: t.debit.plus(l.debit), credit: t.credit.plus(l.credit) }),
    { debit: ZERO, credit: ZERO },
  );
}

export function assertBalanced(d: JournalDraft): void {
  const t = totals(d);
  if (d.lines.length < 2) throw new Error(`${d.sourceType}: a journal needs at least two lines`);
  if (!t.debit.equals(t.credit)) {
    throw new Error(`${d.sourceType}: journal is not balanced (debit ${t.debit}, credit ${t.credit})`);
  }
}

/** Reversal = same lines with debit and credit swapped. Posted records are never edited. */
export function reverse(d: JournalDraft): JournalDraft {
  return {
    sourceType: d.sourceType,
    description: `Reversal: ${d.description}`,
    lines: d.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
}

/** Unique per event so retrying never posts twice (journal_entries.postingKey). */
export const postingKey = (sourceType: string, sourceId: string, event = 'post'): string =>
  `${sourceType}:${sourceId}:${event}`;

// ───────── Purchasing ─────────

/** Goods received are accepted at the supplier invoice value. Landed costs are added to inventory. */
export function purchaseReceipt(p: {
  supplierId: string;
  locationId: string;
  goodsValue: Numeric;
  /** Freight, handling, container. `paidFromAccountId` set = paid in cash/bank now, else owed. */
  costs?: { amount: Numeric; paidFromAccountId?: string }[];
}): JournalDraft {
  const costs = p.costs ?? [];
  const landed = costs.reduce((s, c) => s.plus(c.amount), ZERO);
  const lines: DraftLine[] = [
    dr(key('INVENTORY'), D(p.goodsValue).plus(landed), { locationId: p.locationId }),
    cr(key('AP_SUPPLIERS'), p.goodsValue, { supplierId: p.supplierId }),
  ];
  for (const c of costs) {
    lines.push(
      c.paidFromAccountId
        ? cr(acct(c.paidFromAccountId), c.amount)
        : cr(key('AP_SUPPLIERS'), c.amount, { supplierId: p.supplierId }),
    );
  }
  return draft('PURCHASE_RECEIPT', 'Goods received from supplier', lines);
}

export function supplierPayment(p: { supplierId: string; financialAccountId: string; amount: Numeric }): JournalDraft {
  return draft('SUPPLIER_PAYMENT', 'Payment to supplier', [
    dr(key('AP_SUPPLIERS'), p.amount, { supplierId: p.supplierId }),
    cr(acct(p.financialAccountId), p.amount),
  ]);
}

// ───────── Sales ─────────

/** Revenue is recognised at the sale, net of discounts. Customer null = walk-in. */
export function sale(p: {
  locationId: string;
  customerId?: string | null;
  netRevenue: Numeric;
  tax?: Numeric;
}): JournalDraft {
  const total = D(p.netRevenue).plus(p.tax ?? 0);
  return draft('SALE', 'Sale', [
    dr(key('AR_CUSTOMERS'), total, { locationId: p.locationId, customerId: p.customerId ?? null }),
    cr(key('SALES_REVENUE'), p.netRevenue, { locationId: p.locationId }),
    cr(key('TAX_PAYABLE'), p.tax ?? 0, { locationId: p.locationId }),
  ]);
}

/**
 * Cost of goods sold is recognised when stock is released. Profit belongs to the SELLING
 * store; the inventory reduction belongs to the SUPPLYING location.
 */
export function saleRelease(p: { sellingLocationId: string; supplyLocationId: string; cost: Numeric }): JournalDraft {
  return draft('SALE_RELEASE', 'Cost of goods released', [
    dr(key('COGS'), p.cost, { locationId: p.sellingLocationId }),
    cr(key('INVENTORY'), p.cost, { locationId: p.supplyLocationId }),
  ]);
}

/** Receiving money. Allocation to invoices is a sub-ledger step and posts nothing. */
export function customerPayment(p: { customerId?: string | null; financialAccountId: string; amount: Numeric }): JournalDraft {
  return draft('CUSTOMER_PAYMENT', 'Payment from customer', [
    dr(acct(p.financialAccountId), p.amount),
    cr(key('AR_CUSTOMERS'), p.amount, { customerId: p.customerId ?? null }),
  ]);
}

export function customerRefund(p: { customerId: string; financialAccountId: string; amount: Numeric }): JournalDraft {
  return draft('CUSTOMER_REFUND', 'Refund to customer', [
    dr(key('AR_CUSTOMERS'), p.amount, { customerId: p.customerId }),
    cr(acct(p.financialAccountId), p.amount),
  ]);
}

/** Return against a sale. If goods go back on the shelf, inventory comes back at original cost. */
export function saleReturn(p: {
  locationId: string;
  customerId?: string | null;
  netRevenue: Numeric;
  tax?: Numeric;
  restock?: { locationId: string; cost: Numeric };
}): JournalDraft {
  const total = D(p.netRevenue).plus(p.tax ?? 0);
  const lines: DraftLine[] = [
    dr(key('SALES_RETURNS'), p.netRevenue, { locationId: p.locationId }),
    dr(key('TAX_PAYABLE'), p.tax ?? 0, { locationId: p.locationId }),
    cr(key('AR_CUSTOMERS'), total, { locationId: p.locationId, customerId: p.customerId ?? null }),
  ];
  if (p.restock) {
    lines.push(
      dr(key('INVENTORY'), p.restock.cost, { locationId: p.restock.locationId }),
      cr(key('COGS'), p.restock.cost, { locationId: p.locationId }),
    );
  }
  return draft('SALE_RETURN', 'Sales return', lines);
}

// ───────── Stock ─────────

export function transferDispatch(p: { fromLocationId: string; cost: Numeric }): JournalDraft {
  return draft('TRANSFER_DISPATCH', 'Stock dispatched', [
    dr(key('GOODS_IN_TRANSIT'), p.cost),
    cr(key('INVENTORY'), p.cost, { locationId: p.fromLocationId }),
  ]);
}

export function transferReceive(p: { toLocationId: string; cost: Numeric }): JournalDraft {
  return draft('TRANSFER_RECEIVE', 'Stock received from transfer', [
    dr(key('INVENTORY'), p.cost, { locationId: p.toLocationId }),
    cr(key('GOODS_IN_TRANSIT'), p.cost),
  ]);
}

/** Missing or damaged quantity found when a transfer is received. */
export function transferLoss(p: { cost: Numeric }): JournalDraft {
  return draft('TRANSFER_LOSS', 'Transfer shortage written off', [
    dr(key('INVENTORY_ADJUSTMENTS'), p.cost),
    cr(key('GOODS_IN_TRANSIT'), p.cost),
  ]);
}

/** Approved count difference. Negative `value` = stock gain. */
export function stockAdjustment(p: { locationId: string; lossValue: Numeric }): JournalDraft {
  const v = D(p.lossValue);
  const abs = v.abs();
  return draft('STOCK_ADJUSTMENT', v.gte(0) ? 'Stock count loss' : 'Stock count gain', [
    v.gte(0) ? dr(key('INVENTORY_ADJUSTMENTS'), abs) : dr(key('INVENTORY'), abs, { locationId: p.locationId }),
    v.gte(0) ? cr(key('INVENTORY'), abs, { locationId: p.locationId }) : cr(key('INVENTORY_ADJUSTMENTS'), abs),
  ]);
}

export function stockDamage(p: { locationId: string; cost: Numeric }): JournalDraft {
  return draft('STOCK_DAMAGE', 'Damaged or expired stock', [
    dr(key('INVENTORY_DAMAGE'), p.cost),
    cr(key('INVENTORY'), p.cost, { locationId: p.locationId }),
  ]);
}

// ───────── Cash and expenses ─────────

/**
 * Money moved between cash/bank accounts. A bank deposit first sits in "cash in transit"
 * and moves to the bank when confirmed. It is never revenue.
 */
export function fundsTransferSent(p: { fromAccountId: string; amount: Numeric; viaTransit: boolean; toAccountId?: string }): JournalDraft {
  if (!p.viaTransit && !p.toAccountId) throw new Error('Direct transfer needs a destination account');
  return draft('FUNDS_TRANSFER', 'Funds sent', [
    p.viaTransit ? dr(key('CASH_IN_TRANSIT'), p.amount) : dr(acct(p.toAccountId!), p.amount),
    cr(acct(p.fromAccountId), p.amount),
  ]);
}

export function fundsTransferConfirmed(p: { toAccountId: string; amount: Numeric }): JournalDraft {
  return draft('FUNDS_TRANSFER_CONFIRMED', 'Deposit confirmed by bank', [
    dr(acct(p.toAccountId), p.amount),
    cr(key('CASH_IN_TRANSIT'), p.amount),
  ]);
}

/** Counted cash differs from expected. Positive = shortage. */
export function cashDifference(p: { financialAccountId: string; shortage: Numeric }): JournalDraft {
  const v = D(p.shortage);
  const abs = v.abs();
  return draft('CASH_DIFFERENCE', v.gte(0) ? 'Cash shortage' : 'Cash overage', [
    v.gte(0) ? dr(key('CASH_DIFFERENCES'), abs) : dr(acct(p.financialAccountId), abs),
    v.gte(0) ? cr(acct(p.financialAccountId), abs) : cr(key('CASH_DIFFERENCES'), abs),
  ]);
}

export function bankFee(p: { financialAccountId: string; amount: Numeric }): JournalDraft {
  return draft('BANK_FEE', 'Bank fee', [dr(key('BANK_FEES'), p.amount), cr(acct(p.financialAccountId), p.amount)]);
}

export function expense(p: {
  expenseAccountId: string;
  amount: Numeric;
  locationId?: string | null;
  paidBy:
  | { financialAccountId: string }
  | { supplierId: string } // unpaid bill from a vendor
  | { employeeId: string }; // employee paid, company reimburses later
}): JournalDraft {
  const dims = { locationId: p.locationId ?? null };
  const credit =
    'financialAccountId' in p.paidBy
      ? cr(acct(p.paidBy.financialAccountId), p.amount)
      : 'supplierId' in p.paidBy
        ? cr(key('AP_SUPPLIERS'), p.amount, { supplierId: p.paidBy.supplierId })
        : cr(key('EMPLOYEE_PAYABLE'), p.amount, { employeeId: p.paidBy.employeeId });
  return draft('EXPENSE', 'Expense', [dr(acct(p.expenseAccountId), p.amount, dims), credit]);
}

// ───────── Payroll ─────────

export function salaryEarned(p: { employeeId: string; amount: Numeric; locationId?: string | null }): JournalDraft {
  return draft('SALARY_EARNED', 'Salary earned', [
    dr(key('SALARY_EXPENSE'), p.amount, { locationId: p.locationId ?? null }),
    cr(key('EMPLOYEE_PAYABLE'), p.amount, { employeeId: p.employeeId }),
  ]);
}

/** Salary paid, advance, or withdrawal of held funds all reduce what the company owes the employee. */
export function employeePayment(p: { employeeId: string; financialAccountId: string; amount: Numeric }): JournalDraft {
  return draft('EMPLOYEE_PAYMENT', 'Payment to employee', [
    dr(key('EMPLOYEE_PAYABLE'), p.amount, { employeeId: p.employeeId }),
    cr(acct(p.financialAccountId), p.amount),
  ]);
}

// ───────── Opening balances ─────────

/** One balanced entry for imported opening data. The difference goes to Opening balance equity. */
export function openingBalances(p: {
  inventory?: { locationId: string; value: Numeric }[];
  receivables?: { customerId: string; amount: Numeric }[];
  payables?: { supplierId: string; amount: Numeric }[];
  employeePayables?: { employeeId: string; amount: Numeric }[];
  cash?: { financialAccountId: string; amount: Numeric }[];
}): JournalDraft {
  const lines: DraftLine[] = [
    ...(p.inventory ?? []).map((i) => dr(key('INVENTORY'), i.value, { locationId: i.locationId })),
    ...(p.receivables ?? []).map((r) => dr(key('AR_CUSTOMERS'), r.amount, { customerId: r.customerId })),
    ...(p.cash ?? []).map((c) => dr(acct(c.financialAccountId), c.amount)),
    ...(p.payables ?? []).map((x) => cr(key('AP_SUPPLIERS'), x.amount, { supplierId: x.supplierId })),
    ...(p.employeePayables ?? []).map((e) => cr(key('EMPLOYEE_PAYABLE'), e.amount, { employeeId: e.employeeId })),
  ];
  const debit = lines.reduce((s, l) => s.plus(l.debit), ZERO);
  const credit = lines.reduce((s, l) => s.plus(l.credit), ZERO);
  const diff = debit.minus(credit);
  if (diff.gt(0)) lines.push(cr(key('OPENING_EQUITY'), diff));
  if (diff.lt(0)) lines.push(dr(key('OPENING_EQUITY'), diff.abs()));
  return draft('OPENING_BALANCES', 'Opening balances', lines);
}

/** Stock counted in when the system starts. Inventory goes up; the other side is opening balance equity. */
export function openingStock(p: { locationId: string; cost: Numeric }): JournalDraft {
  return draft('OPENING_STOCK', 'Opening stock', [
    dr(key('INVENTORY'), p.cost, { locationId: p.locationId }),
    cr(key('OPENING_EQUITY'), p.cost),
  ]);
}
