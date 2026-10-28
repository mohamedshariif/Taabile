import { describe, expect, it } from 'vitest';
import { createReceiptSchema, voidReceiptSchema } from '../src/modules/purchases/purchases.schemas.js';
import { can, type Principal } from '../src/modules/auth/permissions.js';
import { allocateByWeight } from '../src/shared/money.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { supplierId: id(1), locationId: id(2), lines: [{ productId: id(3), qtyReceived: '10', unitPrice: '2.5' }] };
const who = (role: Principal['role']): Principal => ({ userId: id(9), role, locationIds: [id(2)], extraPermissions: [], revokedPermissions: [] });

describe('purchase receipt input', () => {
  it('accepts a normal receipt and fills the defaults', () => {
    const r = createReceiptSchema.parse(base);
    expect(r.costs).toEqual([]);
    expect(r.lines[0]!.qtyReceived).toBe('10');
  });
  it('rejects empty, zero, duplicate and badly formed input', () => {
    const bad = (over: object) => createReceiptSchema.safeParse({ ...base, ...over }).success;
    expect(bad({ lines: [] })).toBe(false);
    expect(bad({ lines: [{ ...base.lines[0], qtyReceived: '0' }] })).toBe(false);
    expect(bad({ lines: [{ ...base.lines[0], unitPrice: '1.23456' }] })).toBe(false); // supplier invoices have at most 4 decimals
    expect(bad({ lines: [base.lines[0], base.lines[0]] })).toBe(false);
    expect(bad({ costs: [{ type: 'FREIGHT', amount: '0' }] })).toBe(false);
    expect(bad({ costs: [{ type: 'TAX', amount: '5' }] })).toBe(false);
    expect(bad({ invoiceDate: '2026-03-10', dueDate: '2026-03-01' })).toBe(false);
    expect(bad({ receivedAt: '10/03/2026' })).toBe(false);
    expect(voidReceiptSchema.safeParse({ reason: 'x' }).success).toBe(false);
  });
});

describe('who can record purchases', () => {
  it('Admin and Manager record at their locations; a Viewer and Staff only read or nothing', () => {
    expect(can(who('MANAGER'), 'purchases.manage', { locationId: id(2) })).toBe(true);
    expect(can(who('MANAGER'), 'purchases.manage', { locationId: id(7) })).toBe(false);
    expect([can(who('VIEWER'), 'purchases.view'), can(who('VIEWER'), 'purchases.manage')]).toEqual([true, false]);
    expect([can(who('STAFF'), 'purchases.view'), can(who('STAFF'), 'purchases.manage')]).toEqual([false, false]);
  });
});

describe('sharing landed costs', () => {
  it('splits by value and always adds up to the total', () => {
    expect(allocateByWeight('200', ['1200', '800']).map(String)).toEqual(['120', '80']);
    const odd = allocateByWeight('100', ['1', '1', '1']);
    expect(odd.reduce((s, x) => s.plus(x), allocateByWeight('0', ['1'])[0]!).toFixed(4)).toBe('100.0000');
  });
});