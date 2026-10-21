import { describe, expect, it } from 'vitest';
import { canApprove, can, type Principal } from '../src/modules/auth/permissions.js';

const base = { extraPermissions: [], revokedPermissions: [] };
const admin: Principal = { userId: 'a', role: 'ADMIN', locationIds: [], ...base };
const manager: Principal = { userId: 'm', role: 'MANAGER', locationIds: ['storeA'], ...base };
const staff: Principal = { userId: 's1', role: 'STAFF', locationIds: ['storeA'], ...base };
const viewer: Principal = { userId: 'v', role: 'VIEWER', locationIds: [], ...base };

describe('permissions', () => {
  it('admin can do everything company-wide', () => {
    expect(can(admin, 'users.manage')).toBe(true);
    expect(can(admin, 'accounting.manage')).toBe(true);
  });

  it('manager is limited to their own location, but sees stock company-wide', () => {
    expect(can(manager, 'sales.create', { locationId: 'storeA' })).toBe(true);
    expect(can(manager, 'sales.create', { locationId: 'storeB' })).toBe(false);
    expect(can(manager, 'stock.view', { locationId: 'storeB' })).toBe(true);
    expect(can(manager, 'stock.receive', { locationId: 'storeB' })).toBe(false);
  });

  it('staff only see their own sales', () => {
    expect(can(staff, 'sales.view', { ownerUserId: 's1' })).toBe(true);
    expect(can(staff, 'sales.view', { ownerUserId: 's2' })).toBe(false);
  });

  it('staff cannot see cost or profit, or void a sale', () => {
    expect(can(staff, 'cost.view')).toBe(false);
    expect(can(staff, 'sales.void')).toBe(false);
    expect(can(staff, 'sales.void_request')).toBe(true);
  });

  it('viewer is read-only', () => {
    expect(can(viewer, 'reports.view')).toBe(true);
    expect(can(viewer, 'cost.view')).toBe(true);
    expect(can(viewer, 'sales.create')).toBe(false);
    expect(can(viewer, 'stock.receive')).toBe(false);
  });

  it('admin can switch a permission on for one staff user, limited to their location', () => {
    const warehouse: Principal = { ...staff, extraPermissions: ['stock.receive'] };
    expect(can(warehouse, 'stock.receive', { locationId: 'storeA' })).toBe(true);
    expect(can(warehouse, 'stock.receive', { locationId: 'storeB' })).toBe(false);
  });

  it('admin can switch a permission off for one manager', () => {
    const limited: Principal = { ...manager, revokedPermissions: ['expenses.create'] };
    expect(can(limited, 'expenses.create', { locationId: 'storeA' })).toBe(false);
  });

  it('nobody approves their own action', () => {
    expect(canApprove('m', 'm')).toBe(false);
    expect(canApprove('m', 's1')).toBe(true);
  });
});
