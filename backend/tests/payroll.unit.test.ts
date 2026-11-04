import { describe, expect, it } from 'vitest';
import {
  accrueSchema,
  adjustSchema,
  createEmployeeSchema,
  employeeListQuery,
  linkableQuery,
  paySchema,
  salarySchema,
  updateEmployeeSchema
} from '../src/modules/payroll/payroll.schemas.js';

const id = '3f2c1d9e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';

describe('payroll inputs', () => {
  it('a month is YYYY-MM', () => {
    expect(accrueSchema.safeParse({ period: '2026-10' }).success).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '10-2026', '2026-10-01', '']) expect(accrueSchema.safeParse({ period: bad }).success).toBe(false);
  });

  it('pay needs a real amount with at most 2 decimals and a known kind', () => {
    const ok = { employeeId: id, kind: 'SALARY', amount: '150.50', financialAccountId: id };
    expect(paySchema.safeParse(ok).success).toBe(true);
    expect(paySchema.safeParse({ ...ok, kind: 'ADVANCE' }).success).toBe(true);
    for (const amount of ['0', '-5', '1.005', 'abc', '']) expect(paySchema.safeParse({ ...ok, amount }).success).toBe(false);
    expect(paySchema.safeParse({ ...ok, kind: 'BONUS' }).success).toBe(false);
  });

  it('an adjustment may be plus or minus, never zero, and needs a note', () => {
    const ok = { employeeId: id, amount: '-20.00', note: 'late three days' };
    expect(adjustSchema.safeParse(ok).success).toBe(true);
    expect(adjustSchema.safeParse({ ...ok, amount: '+15' }).success).toBe(true);
    expect(adjustSchema.safeParse({ ...ok, amount: 20 }).success).toBe(true);
    for (const amount of ['0', '0.00', '-0', '1.234', 'x']) expect(adjustSchema.safeParse({ ...ok, amount }).success).toBe(false);
    expect(adjustSchema.safeParse({ ...ok, note: 'x' }).success).toBe(false);
  });

  it('a new employee: a name, and pay dates only with an amount', () => {
    expect(createEmployeeSchema.safeParse({ name: 'Achol Deng' }).success).toBe(true);
    expect(createEmployeeSchema.safeParse({ name: 'Achol Deng', monthlyAmount: '300.00', salaryFrom: '2026-10-01' }).success).toBe(true);
    expect(createEmployeeSchema.safeParse({ name: 'Achol Deng', salaryFrom: '2026-10-01' }).success).toBe(false);
    expect(createEmployeeSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(createEmployeeSchema.safeParse({ name: 'A', monthlyAmount: '0' }).success).toBe(false);
  });

  it('a pay change needs an amount and a start day', () => {
    expect(salarySchema.safeParse({ monthlyAmount: '400', effectiveFrom: '2026-11-01' }).success).toBe(true);
    expect(salarySchema.safeParse({ monthlyAmount: '400', effectiveFrom: '2026-02-30' }).success).toBe(false);
    expect(salarySchema.safeParse({ monthlyAmount: '400' }).success).toBe(false);
  });
});
describe('editing an employee and linking a login', () => {
  it('a login is a uuid; an edit may remove the link with null, but not be empty', () => {
    expect(createEmployeeSchema.safeParse({ name: 'Achol', userId: id }).success).toBe(true);
    expect(createEmployeeSchema.safeParse({ name: 'Achol', userId: 'nope' }).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ userId: null }).success).toBe(true);
    expect(updateEmployeeSchema.safeParse({ userId: id, phone: null, position: null }).success).toBe(true);
    expect(updateEmployeeSchema.safeParse({ userId: 'nope' }).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({}).success).toBe(false);
    expect(updateEmployeeSchema.safeParse({ startedOn: '2026-02-30' }).success).toBe(false);
  });

  it('the list can show only people with no pay set, and the picker takes an optional employee', () => {
    expect(employeeListQuery.safeParse({ payNotSet: 'true' }).success).toBe(true);
    expect(employeeListQuery.safeParse({ payNotSet: 'false' }).success).toBe(false);
    expect(linkableQuery.safeParse({}).success).toBe(true);
    expect(linkableQuery.safeParse({ employeeId: id }).success).toBe(true);
    expect(linkableQuery.safeParse({ employeeId: 'x' }).success).toBe(false);
  });
});