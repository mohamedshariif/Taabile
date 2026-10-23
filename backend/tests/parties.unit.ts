import { describe, expect, it } from 'vitest';
import { createCustomerSchema, updateCustomerSchema } from '../src/modules/customers/customers.schemas.js';
import { createSupplierSchema } from '../src/modules/suppliers/suppliers.schemas.js';
import { can, type Principal } from '../src/modules/auth/permissions.js';
import { phoneSchema } from '../src/shared/phone.js';

const who = (role: Principal['role'], extra: string[] = []): Principal => ({ userId: 'u', role, locationIds: [], extraPermissions: extra, revokedPermissions: [] });

describe('phone numbers', () => {
  it('are stored without spaces, dashes or brackets, and must look like a phone number', () => {
    expect(phoneSchema.parse('+211 912-345-678')).toBe('+211912345678');
    expect(phoneSchema.parse(' (0912) 345.678 ')).toBe('0912345678');
    for (const bad of ['abc', '12345', '+', '1234567890123456', '09-12-xx']) expect(phoneSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('customer and supplier input', () => {
  it('trims names, upper-cases codes, turns empty boxes into nothing', () => {
    const c = createCustomerSchema.parse({ name: '  Mary Store ', code: ' c-77 ', phone: '', address: '  ' });
    expect(c).toMatchObject({ name: 'Mary Store', code: 'C-77', phone: null, address: null });
    expect(createSupplierSchema.parse({ name: 'Nile Oil', phone: '0912 345 678' }).phone).toBe('0912345678');
  });

  it('rejects bad values', () => {
    for (const bad of [{ name: 'A' }, { name: 'Ok name', code: 'has space' }, { name: 'Ok name', creditLimit: '-1' }, { name: 'Ok name', creditLimit: '1.23456' }, { name: 'Ok name', paymentTermsDays: 366 }, { name: 'Ok name', paymentTermsDays: 1.5 }, { name: 'Ok name', priceListId: 'x' }]) {
      expect(createCustomerSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('credit limit can be a number or empty; an update must change something', () => {
    expect(createCustomerSchema.parse({ name: 'Ok name', creditLimit: 250 }).creditLimit).toBe('250');
    expect(updateCustomerSchema.parse({ creditLimit: null }).creditLimit).toBeNull();
    expect(updateCustomerSchema.safeParse({}).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
  });
});

describe('who may do what with customers and suppliers', () => {
  it('Admin everything; Manager manages but cannot set credit or delete; Staff only sees customers; Viewer only looks', () => {
    expect(['customers.manage', 'credit.manage', 'suppliers.manage', 'records.delete'].every((p) => can(who('ADMIN'), p as never))).toBe(true);
    const m = who('MANAGER');
    expect([can(m, 'customers.manage'), can(m, 'suppliers.manage'), can(m, 'suppliers.view')]).toEqual([true, true, true]);
    expect([can(m, 'credit.manage'), can(m, 'records.delete')]).toEqual([false, false]);
    expect(can(who('MANAGER', ['credit.manage']), 'credit.manage')).toBe(true);
    expect(can(who('MANAGER', ['records.delete']), 'records.delete')).toBe(false);
    const s = who('STAFF');
    expect([can(s, 'customers.view'), can(s, 'customers.manage'), can(s, 'suppliers.view')]).toEqual([true, false, false]);
    const v = who('VIEWER');
    expect([can(v, 'customers.view'), can(v, 'suppliers.view'), can(v, 'suppliers.manage'), can(v, 'customers.manage')]).toEqual([true, true, false, false]);
  });
});