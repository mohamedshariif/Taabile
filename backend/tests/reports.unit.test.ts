import { describe, expect, it } from 'vitest';
import { owedQuery, rangeQuery, stockValueQuery } from '../src/modules/reports/reports.schemas.js';

describe('report filters', () => {
  it('a range may be empty, or have both dates in order and at most a year apart', () => {
    expect(rangeQuery.safeParse({}).success).toBe(true);
    expect(rangeQuery.safeParse({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
    expect(rangeQuery.safeParse({ from: '2026-10-31', to: '2026-10-01' }).success).toBe(false);
    expect(rangeQuery.safeParse({ from: '2025-10-01', to: '2026-10-01' }).success).toBe(true); // 366 days counting both ends
    expect(rangeQuery.safeParse({ from: '2025-09-30', to: '2026-10-01' }).success).toBe(false);
    expect(rangeQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(rangeQuery.safeParse({ locationId: 'not-an-id' }).success).toBe(false);
  });

  it('stock value limits and place filters are checked', () => {
    expect(stockValueQuery.parse({}).limit).toBe(200);
    expect(stockValueQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(stockValueQuery.safeParse({ limit: '1001' }).success).toBe(false);
    expect(owedQuery.safeParse({ locationId: 'x' }).success).toBe(false);
  });
});