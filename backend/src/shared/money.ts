import { Decimal } from 'decimal.js';

// Money is USD only. Stored with 4 decimals, rounded to 2 decimals per invoice line.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Numeric = Decimal | string | number;
export const D = (v: Numeric): Decimal => new Decimal(v);
export const ZERO = new Decimal(0);

export const tryD = (v: Numeric): Decimal | null => {
  try {
    return new Decimal(v);
  } catch {
    return null;
  }
};

/** Round a line amount to cents (invoice lines, payments). */
export const roundMoney = (v: Numeric): Decimal => D(v).toDecimalPlaces(2);
/** Round to the 4 decimals used in storage. */
export const storeMoney = (v: Numeric): Decimal => D(v).toDecimalPlaces(4);
/** Quantities are shown with 3 decimals and stored with 4. */
export const storeQty = (v: Numeric): Decimal => D(v).toDecimalPlaces(4);
/** Unit costs keep 6 decimals so average cost does not drift. */
export const storeCost = (v: Numeric): Decimal => D(v).toDecimalPlaces(6);

/**
 * Split `total` across `weights` so the parts add up to exactly `total` (largest remainder).
 * Used for freight and container costs allocated to items by value.
 */
export function allocateByWeight(total: Numeric, weights: Numeric[], places = 4): Decimal[] {
  const t = D(total).toDecimalPlaces(places);
  const w = weights.map(D);
  const sum = w.reduce((a, b) => a.plus(b), ZERO);
  if (w.length === 0) return [];
  if (sum.isZero()) throw new Error('Cannot allocate by zero total weight');
  const unit = new Decimal(10).pow(-places);
  const raw = w.map((x) => t.times(x).div(sum));
  const parts = raw.map((x) => x.toDecimalPlaces(places, Decimal.ROUND_DOWN));
  let left = t.minus(parts.reduce((a, b) => a.plus(b), ZERO));
  const order = raw
    .map((x, i) => ({ i, rem: x.minus(parts[i]!) }))
    .sort((a, b) => b.rem.comparedTo(a.rem));
  for (const { i } of order) {
    if (left.lte(0)) break;
    parts[i] = parts[i]!.plus(unit);
    left = left.minus(unit);
  }
  return parts;
}

/** New weighted average cost after receiving stock. Returns the old cost if nothing is on hand and nothing arrives. */
export function weightedAverageCost(
  onHand: Numeric,
  avgCost: Numeric,
  inQty: Numeric,
  inUnitCost: Numeric,
): Decimal {
  const q0 = D(onHand);
  const q1 = D(inQty);
  const total = q0.plus(q1);
  if (total.lte(0)) return storeCost(avgCost);
  return storeCost(q0.times(avgCost).plus(q1.times(inUnitCost)).div(total));
}
