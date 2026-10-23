import { describe, expect, it } from 'vitest';
import { emptyDraft, emptyUnit, describeUnit, formatPrice, hasProblems, priceProblem, toCreateBody, trimNumber, unitProblems, unitsLine, validateDraft } from './products';

describe('number text', () => {
  it('trims trailing zeros and shows prices with at least 2 decimals', () => {
    expect(trimNumber('50.000000')).toBe('50');
    expect(trimNumber('0.500')).toBe('0.5');
    expect(trimNumber('100')).toBe('100');
    expect(formatPrice('45.0000')).toBe('45.00');
    expect(formatPrice('0.1250')).toBe('0.125');
    expect(formatPrice('1')).toBe('1.00');
  });

  it('describes units the way people say them', () => {
    expect(describeUnit({ name: 'Sack 50 kg', factor: '50', isBase: false }, 'kg')).toBe('1 Sack 50 kg = 50 kg');
    expect(describeUnit({ name: 'kg', factor: '1', isBase: true }, 'kg')).toBe('kg (base unit)');
    const line = unitsLine({
      baseUnit: 'kg',
      units: [
        { id: '1', name: 'kg', factor: '1', isBase: true, isPurchaseUnit: true, isSaleUnit: true, barcode: null, status: 'ACTIVE' },
        { id: '2', name: 'Sack 50 kg', factor: '50', isBase: false, isPurchaseUnit: true, isSaleUnit: true, barcode: null, status: 'ACTIVE' },
        { id: '3', name: 'Old sack', factor: '49', isBase: false, isPurchaseUnit: true, isSaleUnit: true, barcode: null, status: 'INACTIVE' },
      ],
    });
    expect(line).toBe('kg · Sack 50 kg (50)'); // switched-off units are not listed
  });
});

describe('package checks (mirror the server)', () => {
  const others = [{ name: 'kg', barcode: null }, { name: 'Sack 50 kg', barcode: '6001000000050' }];
  const ok = { name: 'Sack 25 kg', factor: '25', barcode: '' };

  it('accepts a good package', () => {
    expect(unitProblems(ok, others, true)).toEqual({});
  });

  it('catches duplicate names whatever the capitals, and duplicate barcodes', () => {
    expect(unitProblems({ ...ok, name: 'SACK 50 KG' }, others, true).name).toMatch(/already has/);
    expect(unitProblems({ ...ok, name: 'KG' }, others, true).name).toMatch(/already has/);
    expect(unitProblems({ ...ok, barcode: '6001000000050' }, others, true).barcode).toMatch(/same barcode/);
    expect(unitProblems({ ...ok, barcode: '12 34' }, others, true).barcode).toMatch(/4 to 32/);
  });

  it('checks the conversion number', () => {
    for (const bad of ['', 'abc', '0', '-5', '1000001', '1.1234567', '1,5']) {
      expect(unitProblems({ ...ok, factor: bad }, others, true).factor, bad).toBeTruthy();
    }
    for (const good of ['1', '0.5', '24.000001', '1000000']) {
      expect(unitProblems({ ...ok, factor: good }, others, true).factor, good).toBeUndefined();
    }
  });

  it('products counted in whole pieces need whole-number packages', () => {
    expect(unitProblems({ ...ok, factor: '12' }, others, false).factor).toBeUndefined();
    expect(unitProblems({ ...ok, factor: '6.5' }, others, false).factor).toMatch(/whole/);
    expect(unitProblems({ ...ok, factor: '6.5' }, others, true).factor).toBeUndefined();
  });
});

describe('new product form', () => {
  const sugar = () => ({
    ...emptyDraft(),
    name: 'White sugar',
    baseName: 'kg',
    units: [
      { ...emptyUnit(), name: 'Sack 50 kg', factor: '50', isPurchaseUnit: true, barcode: '6001000000050' },
      { ...emptyUnit(), name: 'Sack 25 kg', factor: '25' },
    ],
  });

  it('a good form has no problems and builds the request the server expects', () => {
    expect(hasProblems(validateDraft(sugar()))).toBe(false);
    expect(toCreateBody({ ...sugar(), sku: ' sug-1 ' })).toEqual({
      name: 'White sugar',
      sku: 'SUG-1',
      allowFractions: true,
      baseUnit: { name: 'kg' },
      units: [
        { name: 'Sack 50 kg', factor: '50', isPurchaseUnit: true, isSaleUnit: true, barcode: '6001000000050' },
        { name: 'Sack 25 kg', factor: '25', isPurchaseUnit: false, isSaleUnit: true },
      ],
    });
  });

  it('an empty form asks for a name and a base unit', () => {
    const p = validateDraft(emptyDraft());
    expect(p.name).toBeTruthy();
    expect(p.baseName).toBeTruthy();
  });

  it('finds problems inside packages, including repeats of the base unit and between packages', () => {
    const d = sugar();
    d.units[1] = { ...d.units[1]!, name: 'sack 50 KG', factor: 'x' };
    const p = validateDraft(d);
    expect(p.units[1]?.name).toBeTruthy();
    expect(p.units[1]?.factor).toBeTruthy();
    expect(p.units[0]?.name).toBeTruthy(); // the clash is reported on both
    const d2 = { ...sugar(), baseName: 'Sack 25 kg' };
    expect(validateDraft(d2).units[1]?.name).toMatch(/already has/);
    const d3 = { ...sugar(), baseBarcode: '6001000000050' };
    expect(validateDraft(d3).units[0]?.barcode).toMatch(/same barcode/);
  });

  it('a whole-piece product rejects fractional packages', () => {
    const d = { ...sugar(), allowFractions: false };
    d.units[0] = { ...d.units[0]!, factor: '12.5' };
    expect(validateDraft(d).units[0]?.factor).toMatch(/whole/);
  });

  it('product code is optional but must look right', () => {
    expect(validateDraft({ ...sugar(), sku: '' }).sku).toBeUndefined();
    expect(validateDraft({ ...sugar(), sku: 'ok-1' }).sku).toBeUndefined();
    expect(validateDraft({ ...sugar(), sku: 'has space' }).sku).toBeTruthy();
  });
});

describe('price text', () => {
  it('empty is fine (no price), numbers up to 4 decimals are fine, anything else is not', () => {
    expect(priceProblem('')).toBeNull();
    expect(priceProblem('45')).toBeNull();
    expect(priceProblem('45.5')).toBeNull();
    expect(priceProblem('0.1234')).toBeNull();
    for (const bad of ['-1', 'abc', '1.23456', '1,5', '1e3']) expect(priceProblem(bad), bad).toBeTruthy();
  });
});