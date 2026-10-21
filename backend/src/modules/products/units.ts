import type { Decimal } from 'decimal.js';
import { D, ZERO, tryD, type Numeric } from '../../shared/money.js';

/** 3 sacks of 50 kg -> 150 kg. */
export const toBase = (quantity: Numeric, factor: Numeric): Decimal => D(quantity).times(D(factor));

/** 150 kg in sacks of 50 kg -> 3. */
export const fromBase = (baseQuantity: Numeric, factor: Numeric): Decimal => D(baseQuantity).div(D(factor));

/** A whole number such as 12 (no decimals). */
export const isWhole = (v: Numeric): boolean => tryD(v)?.isInteger() ?? false;

/**
 * Is this quantity allowed for the product?
 * Products counted in whole pieces (bottles, tins) must always come to a whole number of base units.
 * Half a carton of 12 bottles is 6 bottles: fine. Half a bottle is refused.
 * Returns an error message, or null when the quantity is fine.
 */
export function checkQuantity(allowFractions: boolean, quantity: Numeric, factor: Numeric): string | null {
  const q = D(quantity);
  if (q.lte(0)) return 'Quantity must be more than zero';
  if (!allowFractions && !toBase(q, factor).isInteger()) {
    return 'This product is counted in whole pieces, so that quantity does not make a whole number';
  }
  return null;
}

export interface UnitLike {
  name: string;
  factor: Numeric;
}

/**
 * Shows a base quantity the way people say it: 19,995 kg with sacks of 50 kg and 25 kg
 * becomes [399 x Sack 50 kg, 1 x Sack 25 kg, 20 x kg]. Used on stock screens.
 * `units` must include the base unit (factor 1), which receives whatever is left over.
 */
export function splitIntoPackages(baseQuantity: Numeric, units: UnitLike[]): { name: string; quantity: string }[] {
  let left = D(baseQuantity);
  const out: { name: string; quantity: string }[] = [];
  const bigToSmall = [...units].sort((a, b) => D(b.factor).comparedTo(D(a.factor)));
  for (const u of bigToSmall) {
    if (left.lte(ZERO)) break;
    const f = D(u.factor);
    if (f.lt(1)) continue; // packages smaller than the base unit are not used for splitting
    const isBase = f.equals(1);
    const count = isBase ? left : left.div(f).floor();
    if (count.gt(0)) {
      out.push({ name: u.name, quantity: count.toDecimalPlaces(4).toFixed() });
      left = left.minus(count.times(f));
    }
  }
  return out;
}