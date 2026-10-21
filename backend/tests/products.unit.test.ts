import { describe, expect, it } from 'vitest';
import { ROLE_PRESETS, can, type Principal } from '../src/modules/auth/permissions.js';
import {
  addUnitSchema,
  createProductSchema,
  productListQuery,
  setPricesSchema,
  skuSchema,
  updateUnitSchema,
} from '../src/modules/products/products.schemas.js';
import { checkQuantity, fromBase, splitIntoPackages, toBase } from '../src/modules/products/units.js';

const U1 = '3f1c8a52-1111-4a6e-9a55-0c0b1b5d0001';
const U2 = '3f1c8a52-1111-4a6e-9a55-0c0b1b5d0002';

describe('package conversions', () => {
  it('converts to and from the base unit', () => {
    expect(toBase(3, '50').toString()).toBe('150');
    expect(toBase('0.5', 50).toString()).toBe('25');
    expect(fromBase(150, 50).toString()).toBe('3');
  });

  it('whole-piece products only accept quantities that make a whole number of base units', () => {
    expect(checkQuantity(false, '0.5', 12)).toBeNull(); // half a carton of 12 bottles = 6 bottles
    expect(checkQuantity(false, '0.5', 1)).toMatch(/whole pieces/); // half a bottle
    expect(checkQuantity(true, '0.5', 1)).toBeNull(); // half a kilo is fine
    expect(checkQuantity(true, 0, 1)).toMatch(/more than zero/);
  });

  it('shows stock the way people say it', () => {
    const units = [
      { name: 'kg', factor: 1 },
      { name: 'Sack 50 kg', factor: 50 },
      { name: 'Sack 25 kg', factor: 25 },
    ];
    expect(splitIntoPackages(19995, units)).toEqual([
      { name: 'Sack 50 kg', quantity: '399' },
      { name: 'Sack 25 kg', quantity: '1' },
      { name: 'kg', quantity: '20' },
    ]);
    expect(splitIntoPackages('7.5', units)).toEqual([{ name: 'kg', quantity: '7.5' }]);
    expect(splitIntoPackages(0, units)).toEqual([]);
    expect(splitIntoPackages(30, [{ name: 'bottle', factor: 1 }, { name: 'Carton', factor: 12 }])).toEqual([
      { name: 'Carton', quantity: '2' },
      { name: 'bottle', quantity: '6' },
    ]);
  });
});

describe('create product validation', () => {
  const sugar = {
    name: 'White sugar',
    allowFractions: true,
    baseUnit: { name: 'kg', barcode: null },
    units: [
      { name: 'Sack 50 kg', factor: '50', isPurchaseUnit: true },
      { name: 'Sack 25 kg', factor: 25 },
    ],
  };

  it('accepts a measured product with several package sizes, and fills defaults', () => {
    const r = createProductSchema.safeParse(sugar);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.units[1]).toMatchObject({ factor: '25', isSaleUnit: true, isPurchaseUnit: false });
      expect(r.data.sku).toBeUndefined();
    }
  });

  it('whole-piece products need whole-number packages', () => {
    const bottles = { name: 'Cooking oil 1 L', allowFractions: false, baseUnit: { name: 'bottle' }, units: [{ name: 'Carton', factor: '12' }] };
    expect(createProductSchema.safeParse(bottles).success).toBe(true);
    expect(createProductSchema.safeParse({ ...bottles, units: [{ name: 'Half carton', factor: '6.5' }] }).success).toBe(false);
  });

  it('rejects duplicate unit names (any capitals), including the base unit, and duplicate barcodes', () => {
    expect(createProductSchema.safeParse({ ...sugar, units: [{ name: 'KG', factor: 2 }] }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...sugar, units: [{ name: 'Sack', factor: 50 }, { name: 'sack', factor: 25 }] }).success).toBe(false);
    expect(
      createProductSchema.safeParse({ ...sugar, units: [{ name: 'A', factor: 2, barcode: '12345678' }, { name: 'B', factor: 3, barcode: '12345678' }] }).success,
    ).toBe(false);
  });

  it('checks conversion limits and barcode format', () => {
    for (const bad of ['0', '-5', 'abc', '1000001', '1.1234567', '']) {
      expect(addUnitSchema.safeParse({ name: 'X', factor: bad }).success).toBe(false);
    }
    for (const good of ['1', '0.5', 50, '24.000001', '1000000']) {
      expect(addUnitSchema.safeParse({ name: 'X', factor: good }).success).toBe(true);
    }
    expect(addUnitSchema.safeParse({ name: 'X', factor: 2, barcode: '12 34' }).success).toBe(false);
    expect(addUnitSchema.safeParse({ name: 'X', factor: 2, barcode: '123' }).success).toBe(false);
    expect(addUnitSchema.safeParse({ name: 'X', factor: 2, barcode: '6001234567890' }).success).toBe(true);
  });

  it('product codes are upper-cased and limited to safe characters', () => {
    expect(skuSchema.parse(' sugar-50 ')).toBe('SUGAR-50');
    expect(skuSchema.safeParse('has space').success).toBe(false);
    expect(skuSchema.safeParse('-bad').success).toBe(false);
  });
});

describe('other request shapes', () => {
  it('unit edits need at least one change; null removes a barcode', () => {
    expect(updateUnitSchema.safeParse({}).success).toBe(false);
    expect(updateUnitSchema.safeParse({ barcode: null }).success).toBe(true);
    expect(updateUnitSchema.safeParse({ status: 'INACTIVE' }).success).toBe(true);
  });

  it('prices: money as text, null removes, never negative', () => {
    expect(setPricesSchema.safeParse({ prices: [{ priceListId: U1, unitId: U2, price: '45.00' }] }).success).toBe(true);
    expect(setPricesSchema.safeParse({ prices: [{ priceListId: U1, unitId: U2, price: null }] }).success).toBe(true);
    expect(setPricesSchema.safeParse({ prices: [{ priceListId: U1, unitId: U2, price: '-1' }] }).success).toBe(false);
    expect(setPricesSchema.safeParse({ prices: [] }).success).toBe(false);
  });

  it('product list defaults to active products, 50 per page, and caps the page size', () => {
    expect(productListQuery.parse({})).toMatchObject({ status: 'ACTIVE', limit: 50 });
    expect(productListQuery.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('who can manage products', () => {
  const none = { extraPermissions: [], revokedPermissions: [] };
  const mk = (role: Principal['role']): Principal => ({ userId: role, role, locationIds: [], ...none });

  it('Admin and Manager manage products; only Admin sets prices; Staff and Viewer only look', () => {
    expect(can(mk('ADMIN'), 'products.manage')).toBe(true);
    expect(can(mk('MANAGER'), 'products.manage')).toBe(true);
    expect(can(mk('STAFF'), 'products.manage')).toBe(false);
    expect(can(mk('VIEWER'), 'products.manage')).toBe(false);
    expect(can(mk('ADMIN'), 'prices.manage')).toBe(true);
    expect(can(mk('MANAGER'), 'prices.manage')).toBe(false);
    for (const r of ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'] as const) expect(ROLE_PRESETS[r]['products.view']).toBe('company');
  });

  it('the Admin can switch price editing on for one Manager', () => {
    expect(can({ ...mk('MANAGER'), extraPermissions: ['prices.manage'] }, 'prices.manage')).toBe(true);
  });
});

describe('garbage input is refused cleanly, never a crash', () => {
  it('text that is not a number is a validation error in every money or quantity field', async () => {
    const { manualJournalSchema } = await import('../src/modules/accounting/accounting.schemas.js');
    for (const bad of ['abc', '', ' ', '1,5', '١٢']) {
      expect(() => manualJournalSchema.safeParse({ entryDate: '2026-10-17', description: 'abc', lines: [{ accountId: U1, debit: bad }, { accountId: U2, credit: '1' }] })).not.toThrow();
      expect(() => createProductSchema.safeParse({ name: 'Sugar', baseUnit: { name: 'kg' }, units: [{ name: 'S', factor: bad }] })).not.toThrow();
      expect(() => setPricesSchema.safeParse({ prices: [{ priceListId: U1, unitId: U2, price: bad }] })).not.toThrow();
      expect(manualJournalSchema.safeParse({ entryDate: '2026-10-17', description: 'abc', lines: [{ accountId: U1, debit: bad }, { accountId: U2, credit: '1' }] }).success).toBe(false);
    }
  });
});