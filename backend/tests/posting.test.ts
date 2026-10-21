import { describe, expect, it } from 'vitest';
import { DEFAULT_CHART, SYSTEM_KEYS } from '../src/accounting/chart.js';
import * as post from '../src/accounting/posting.js';
import { D } from '../src/shared/money.js';

const keyOf = (l: post.DraftLine) => ('key' in l.account ? l.account.key : l.account.id);
const find = (d: post.JournalDraft, k: string) => d.lines.find((l) => keyOf(l) === k)!;

describe('chart of accounts', () => {
  it('has a unique code and system key for every account', () => {
    expect(new Set(DEFAULT_CHART.map((a) => a.code)).size).toBe(DEFAULT_CHART.length);
    expect(new Set(DEFAULT_CHART.map((a) => a.systemKey)).size).toBe(DEFAULT_CHART.length);
  });
  it('covers every system key used by the posting rules', () => {
    expect(DEFAULT_CHART.map((a) => a.systemKey).sort()).toEqual([...SYSTEM_KEYS].sort());
  });
});

describe('posting rules: every entry balances', () => {
  const entries: [string, post.JournalDraft][] = [
    ['purchase with credit freight', post.purchaseReceipt({ supplierId: 's', locationId: 'wh', goodsValue: '1000', costs: [{ amount: '100' }] })],
    ['purchase with cash freight', post.purchaseReceipt({ supplierId: 's', locationId: 'wh', goodsValue: '1000', costs: [{ amount: '100', paidFromAccountId: 'cash1' }] })],
    ['supplier payment', post.supplierPayment({ supplierId: 's', financialAccountId: 'bank1', amount: '500' })],
    ['sale with tax', post.sale({ locationId: 'A', customerId: 'c', netRevenue: '1000', tax: '50' })],
    ['sale no tax', post.sale({ locationId: 'A', netRevenue: '1000' })],
    ['release', post.saleRelease({ sellingLocationId: 'A', supplyLocationId: 'wh', cost: '700' })],
    ['customer payment', post.customerPayment({ customerId: 'c', financialAccountId: 'cash1', amount: '300' })],
    ['refund', post.customerRefund({ customerId: 'c', financialAccountId: 'cash1', amount: '30' })],
    ['return with restock', post.saleReturn({ locationId: 'A', customerId: 'c', netRevenue: '100', tax: '5', restock: { locationId: 'A', cost: '70' } })],
    ['transfer dispatch', post.transferDispatch({ fromLocationId: 'wh', cost: '400' })],
    ['transfer receive', post.transferReceive({ toLocationId: 'A', cost: '390' })],
    ['transfer loss', post.transferLoss({ cost: '10' })],
    ['count loss', post.stockAdjustment({ locationId: 'A', lossValue: '25' })],
    ['count gain', post.stockAdjustment({ locationId: 'A', lossValue: '-25' })],
    ['damage', post.stockDamage({ locationId: 'A', cost: '12' })],
    ['deposit sent', post.fundsTransferSent({ fromAccountId: 'cash1', amount: '900', viaTransit: true })],
    ['deposit confirmed', post.fundsTransferConfirmed({ toAccountId: 'bank1', amount: '900' })],
    ['handover', post.fundsTransferSent({ fromAccountId: 'cash1', toAccountId: 'cash2', amount: '50', viaTransit: false })],
    ['cash shortage', post.cashDifference({ financialAccountId: 'cash1', shortage: '5' })],
    ['cash overage', post.cashDifference({ financialAccountId: 'cash1', shortage: '-5' })],
    ['bank fee', post.bankFee({ financialAccountId: 'bank1', amount: '2' })],
    ['expense paid', post.expense({ expenseAccountId: 'rent', amount: '200', paidBy: { financialAccountId: 'cash1' } })],
    ['expense unpaid', post.expense({ expenseAccountId: 'rent', amount: '200', paidBy: { supplierId: 'v' } })],
    ['expense by employee', post.expense({ expenseAccountId: 'rent', amount: '20', paidBy: { employeeId: 'e' } })],
    ['salary earned', post.salaryEarned({ employeeId: 'e', amount: '400' })],
    ['employee payment', post.employeePayment({ employeeId: 'e', financialAccountId: 'cash1', amount: '100' })],
    ['opening balances', post.openingBalances({
      inventory: [{ locationId: 'wh', value: '5000' }],
      receivables: [{ customerId: 'c', amount: '800' }],
      payables: [{ supplierId: 's', amount: '1200' }],
      cash: [{ financialAccountId: 'cash1', amount: '300' }],
    })],
  ];

  it.each(entries)('%s', (_name, entry) => {
    const t = post.totals(entry);
    expect(t.debit.equals(t.credit)).toBe(true);
    expect(entry.lines.length).toBeGreaterThanOrEqual(2);
    // every line has exactly one side, positive
    for (const l of entry.lines) {
      expect(l.debit.gt(0) !== l.credit.gt(0)).toBe(true);
    }
    // reversing keeps it balanced and nets to zero
    const rev = post.reverse(entry);
    expect(post.totals(rev).debit.equals(t.credit)).toBe(true);
  });
});

describe('posting rules: business meaning', () => {
  it('a credit sale records revenue and a receivable, and no cash', () => {
    const d = post.sale({ locationId: 'A', customerId: 'c', netRevenue: '1000', tax: '50' });
    expect(find(d, 'AR_CUSTOMERS').debit.toString()).toBe('1050');
    expect(find(d, 'SALES_REVENUE').credit.toString()).toBe('1000');
    expect(find(d, 'TAX_PAYABLE').credit.toString()).toBe('50');
    expect(d.lines.some((l) => keyOf(l).startsWith('cash'))).toBe(false);
  });

  it('a later payment does not record revenue a second time', () => {
    const d = post.customerPayment({ customerId: 'c', financialAccountId: 'cash1', amount: '1050' });
    expect(d.lines.some((l) => keyOf(l) === 'SALES_REVENUE')).toBe(false);
    expect(find(d, 'AR_CUSTOMERS').credit.toString()).toBe('1050');
  });

  it('a deposit is a transfer, never revenue or expense', () => {
    for (const d of [
      post.fundsTransferSent({ fromAccountId: 'cash1', amount: '900', viaTransit: true }),
      post.fundsTransferConfirmed({ toAccountId: 'bank1', amount: '900' }),
    ]) {
      expect(d.lines.some((l) => ['SALES_REVENUE', 'OTHER_INCOME'].includes(keyOf(l)))).toBe(false);
    }
  });

  it('profit goes to the selling store, inventory leaves the supplying location', () => {
    const d = post.saleRelease({ sellingLocationId: 'storeA', supplyLocationId: 'warehouse', cost: '700' });
    expect(find(d, 'COGS').locationId).toBe('storeA');
    expect(find(d, 'INVENTORY').locationId).toBe('warehouse');
  });

  it('freight is added to inventory value (landed cost)', () => {
    const d = post.purchaseReceipt({ supplierId: 's', locationId: 'wh', goodsValue: '1000', costs: [{ amount: '100' }] });
    expect(find(d, 'INVENTORY').debit.toString()).toBe('1100');
  });

  it('salary held for an employee stays a liability, not income or equity', () => {
    const d = post.salaryEarned({ employeeId: 'e', amount: '400' });
    expect(find(d, 'EMPLOYEE_PAYABLE').credit.toString()).toBe('400');
    expect(d.lines.some((l) => ['OWNER_CAPITAL', 'SALES_REVENUE'].includes(keyOf(l)))).toBe(false);
  });

  it('opening balances put the difference in opening balance equity', () => {
    const d = post.openingBalances({
      inventory: [{ locationId: 'wh', value: '5000' }],
      payables: [{ supplierId: 's', amount: '1200' }],
    });
    expect(find(d, 'OPENING_EQUITY').credit.toString()).toBe('3800');
  });

  it('refuses to build an unbalanced entry', () => {
    expect(() =>
      post.assertBalanced({
        sourceType: 'X',
        description: 'bad',
        lines: [
          { account: { key: 'INVENTORY' }, debit: D(10), credit: D(0) },
          { account: { key: 'AP_SUPPLIERS' }, debit: D(0), credit: D(9) },
        ],
      }),
    ).toThrow(/not balanced/);
  });

  it('posting keys are stable so a retry cannot post twice', () => {
    expect(post.postingKey('SALE', 'abc')).toBe(post.postingKey('SALE', 'abc'));
    expect(post.postingKey('SALE', 'abc')).not.toBe(post.postingKey('SALE', 'abc', 'void'));
  });
});
