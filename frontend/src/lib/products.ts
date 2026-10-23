import type { ProductSummary, ProductUnit } from '../api/types';

// Pure helpers for the product screens (no React, no network), so they are easy to test.
// The server checks everything again; these checks only give instant, friendly feedback while typing.

/** "50.000000" -> "50", "0.500" -> "0.5". */
export const trimNumber = (v: string): string => (v.includes('.') ? v.replace(/\.?0+$/, '') : v);

/** Prices show at least 2 decimals: "45.0000" -> "45.00", "0.125" stays "0.125". */
export function formatPrice(v: string): string {
  const [whole = '0', frac = ''] = v.split('.');
  const t = frac.replace(/0+$/, '');
  return `${whole}.${t.length < 2 ? t.padEnd(2, '0') : t}`;
}

/** "1 Sack 50 kg = 50 kg" (or "kg (base unit)" for the base). */
export function describeUnit(u: Pick<ProductUnit, 'name' | 'factor' | 'isBase'>, baseName: string): string {
  return u.isBase ? `${u.name} (base unit)` : `1 ${u.name} = ${trimNumber(u.factor)} ${baseName}`;
}

/** One line for the product list: "kg · Sack 50 kg (50) · Sack 25 kg (25)". Switched-off units are left out. */
export function unitsLine(p: Pick<ProductSummary, 'baseUnit' | 'units'>): string {
  const packs = p.units.filter((u) => !u.isBase && u.status === 'ACTIVE').map((u) => `${u.name} (${trimNumber(u.factor)})`);
  return [p.baseUnit, ...packs].join(' · ');
}

// ── Checks that mirror the server's rules ──
const BARCODE = /^[A-Za-z0-9._-]{4,32}$/;
const SKU = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const FACTOR = /^\d{1,7}(\.\d{1,6})?$/;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface UnitFields {
  name: string;
  factor: string;
  barcode: string;
}
export interface UnitProblems {
  name?: string;
  factor?: string;
  barcode?: string;
}

/**
 * Problems with one package. `others` are the product's other units (including the base unit), so duplicate
 * names and barcodes are caught before the request is sent. A product counted in whole pieces needs whole-number packages.
 */
export function unitProblems(
  u: UnitFields,
  others: { name: string; barcode: string | null }[],
  allowFractions: boolean,
): UnitProblems {
  const out: UnitProblems = {};
  const name = u.name.trim();
  if (name.length < 1 || name.length > 40) out.name = 'Enter a name (up to 40 characters)';
  else if (others.some((o) => sameName(o.name, name))) out.name = 'This product already has a unit with that name';

  const factor = u.factor.trim();
  if (!FACTOR.test(factor)) out.factor = 'Enter a number, up to 6 decimals';
  else if (Number(factor) <= 0 || Number(factor) > 1_000_000) out.factor = 'Must be more than 0 and at most 1,000,000';
  else if (!allowFractions && !Number.isInteger(Number(factor))) out.factor = 'Counted in whole pieces: a package must hold a whole number';

  const code = u.barcode.trim();
  if (code) {
    if (!BARCODE.test(code)) out.barcode = 'A barcode has 4 to 32 letters or numbers';
    else if (others.some((o) => o.barcode === code)) out.barcode = 'Another unit of this product has the same barcode';
  }
  return out;
}

// ── The "new product" form ──
export interface DraftUnit extends UnitFields {
  isPurchaseUnit: boolean;
  isSaleUnit: boolean;
}
export interface ProductDraft {
  name: string;
  sku: string;
  categoryId: string;
  allowFractions: boolean;
  baseName: string;
  baseBarcode: string;
  units: DraftUnit[];
}
export interface DraftProblems {
  name?: string;
  sku?: string;
  baseName?: string;
  baseBarcode?: string;
  units: Record<number, UnitProblems>;
}

export const emptyUnit = (): DraftUnit => ({ name: '', factor: '', barcode: '', isPurchaseUnit: false, isSaleUnit: true });
export const emptyDraft = (): ProductDraft => ({ name: '', sku: '', categoryId: '', allowFractions: true, baseName: '', baseBarcode: '', units: [] });

export function validateDraft(d: ProductDraft): DraftProblems {
  const out: DraftProblems = { units: {} };
  const name = d.name.trim();
  if (name.length < 2 || name.length > 120) out.name = 'Enter a product name (2 to 120 characters)';
  if (d.sku.trim() && !SKU.test(d.sku.trim().toUpperCase())) out.sku = 'Up to 30 letters, numbers, . _ or - (or leave empty to get one automatically)';

  const base = d.baseName.trim();
  if (base.length < 1 || base.length > 40) out.baseName = 'Enter the base unit, for example kg, litre or piece';
  const baseCode = d.baseBarcode.trim();
  if (baseCode && !BARCODE.test(baseCode)) out.baseBarcode = 'A barcode has 4 to 32 letters or numbers';

  d.units.forEach((u, i) => {
    const others = [
      { name: base, barcode: baseCode || null },
      ...d.units.filter((_, j) => j !== i).map((o) => ({ name: o.name, barcode: o.barcode.trim() || null })),
    ];
    const p = unitProblems(u, others, d.allowFractions);
    // The base unit's own barcode must not repeat on a package either.
    if (!p.barcode && baseCode && u.barcode.trim() === baseCode) p.barcode = 'Another unit of this product has the same barcode';
    if (Object.keys(p).length) out.units[i] = p;
  });
  return out;
}

export const hasProblems = (p: DraftProblems): boolean =>
  Boolean(p.name || p.sku || p.baseName || p.baseBarcode || Object.keys(p.units).length);

/** The request body for POST /api/products: trimmed, empty optional fields left out. */
export function toCreateBody(d: ProductDraft) {
  return {
    name: d.name.trim(),
    ...(d.sku.trim() ? { sku: d.sku.trim().toUpperCase() } : {}),
    ...(d.categoryId ? { categoryId: d.categoryId } : {}),
    allowFractions: d.allowFractions,
    baseUnit: { name: d.baseName.trim(), ...(d.baseBarcode.trim() ? { barcode: d.baseBarcode.trim() } : {}) },
    units: d.units.map((u) => ({
      name: u.name.trim(),
      factor: u.factor.trim(),
      isPurchaseUnit: u.isPurchaseUnit,
      isSaleUnit: u.isSaleUnit,
      ...(u.barcode.trim() ? { barcode: u.barcode.trim() } : {}),
    })),
  };
}

/** Is this price text acceptable? Empty means "no price on this list". */
export const priceProblem = (v: string): string | null => {
  const t = v.trim();
  if (t === '') return null;
  return /^\d{1,13}(\.\d{1,4})?$/.test(t) ? null : 'Use a number with up to 4 decimals';
};