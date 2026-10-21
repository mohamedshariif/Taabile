import { describe, expect, it } from 'vitest';
import { manualJournalSchema } from '../src/modules/accounting/accounting.schemas.js';
import { updateCompanySchema } from '../src/modules/company/company.schemas.js';
import { DEFAULT_CHART, DEFAULT_EXPENSE_CATEGORIES } from '../src/accounting/chart.js';
import { toPage } from '../src/shared/pagination.js';
import { dateOnlySchema, moneyString } from '../src/shared/schemas.js';

const A = '3f1c8a52-1111-4a6e-9a55-0c0b1b5d0001';
const B = '3f1c8a52-1111-4a6e-9a55-0c0b1b5d0002';

describe('default chart', () => {
  it('has 27 accounts with unique codes and keys, and every expense category points at a real account', () => {
    expect(DEFAULT_CHART).toHaveLength(27);
    expect(new Set(DEFAULT_CHART.map((a) => a.code)).size).toBe(27);
    expect(new Set(DEFAULT_CHART.map((a) => a.systemKey)).size).toBe(27);
    const keys = new Set(DEFAULT_CHART.map((a) => a.systemKey));
    for (const c of DEFAULT_EXPENSE_CATEGORIES) expect(keys.has(c.systemKey)).toBe(true);
  });
});

describe('manual journal validation', () => {
  const ok = { entryDate: '2026-10-17', description: 'Owner puts in cash', lines: [{ accountId: A, debit: '10.50' }, { accountId: B, credit: 10.5 }] };
  it('accepts a balanced journal (numbers and strings both)', () => {
    expect(manualJournalSchema.safeParse(ok).success).toBe(true);
  });
  it('rejects unbalanced, one-line, both-sides and impossible dates', () => {
    expect(manualJournalSchema.safeParse({ ...ok, lines: [{ accountId: A, debit: '10' }, { accountId: B, credit: '9' }] }).success).toBe(false);
    expect(manualJournalSchema.safeParse({ ...ok, lines: [{ accountId: A, debit: '10' }] }).success).toBe(false);
    expect(manualJournalSchema.safeParse({ ...ok, lines: [{ accountId: A, debit: '5', credit: '5' }, { accountId: B, credit: '0' }] }).success).toBe(false);
    expect(manualJournalSchema.safeParse({ ...ok, entryDate: '2026-02-31' }).success).toBe(false);
  });
});

describe('small shared rules', () => {
  it('money is a string with at most 4 decimals', () => {
    expect(moneyString.safeParse('12.5').success).toBe(true);
    expect(moneyString.safeParse('12.55555').success).toBe(false);
    expect(moneyString.safeParse('-1').success).toBe(false);
  });
  it('dates must be real calendar dates', () => {
    expect(dateOnlySchema.safeParse('2026-10-17').success).toBe(true);
    expect(dateOnlySchema.safeParse('17/10/2026').success).toBe(false);
  });
  it('company settings: tax 0..100, real time zone, at least one field', () => {
    expect(updateCompanySchema.safeParse({ taxRate: '5.5' }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ taxRate: 101 }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(updateCompanySchema.safeParse({}).success).toBe(false);
  });
  it('paging: the extra row only signals another page', () => {
    const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];
    expect(toPage(rows, 2)).toEqual({ items: [{ id: '1' }, { id: '2' }], nextCursor: '2' });
    expect(toPage(rows, 3)).toEqual({ items: rows, nextCursor: null });
  });
});