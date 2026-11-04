import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { dateOnlySchema, moneyString } from '../../shared/schemas.js';

const uuid = z.string().uuid();
const cents = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && D(v).gt(0), 'Enter an amount above zero, with at most 2 decimals');
/** A correction: plus adds to what the company owes the person (a bonus), minus takes away (a deduction). Never zero. */
const signedCents = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^[+-]?\d{1,15}(\.\d{1,2})?$/.test(v) && !D(v.replace(/^\+/, '')).isZero(), 'Enter an amount other than zero, with at most 2 decimals (minus for a deduction)');
const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().trim().min(3, 'Write at least 3 characters').max(200);
/** A month such as 2026-10. */
export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the format YYYY-MM');

export const employeeListQuery = pageQuerySchema.extend({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  search: z.string().trim().max(60).optional(),
  locationId: uuid.optional(),
  payNotSet: z.enum(['true']).optional(),
});

export const createEmployeeSchema = z
  .object({
    name: text(100),
    phone: text(30).optional(),
    position: text(60).optional(),
    locationId: uuid.optional(),
    startedOn: dateOnlySchema.optional(),
    /** The login (a member of this company) this person uses, if any. */
    userId: uuid.optional(),
    /** The monthly pay from the start. Can be left out and set later. */
    monthlyAmount: cents.optional(),
    /** From when the pay applies. Leave out for the start date, or today. */
    salaryFrom: dateOnlySchema.optional(),
  })
  .refine((v) => !v.salaryFrom || v.monthlyAmount, { message: 'Give the monthly amount too', path: ['monthlyAmount'] });

export const updateEmployeeSchema = z
  .object({
    name: text(100).optional(),
    phone: text(30).nullable().optional(),
    position: text(60).nullable().optional(),
    locationId: uuid.nullable().optional(),
    startedOn: dateOnlySchema.nullable().optional(),
    /** Link to a login of this company, or null to remove the link. */
    userId: uuid.nullable().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const linkableQuery = z.object({ employeeId: uuid.optional() });

export const salarySchema = z.object({ monthlyAmount: cents, effectiveFrom: dateOnlySchema });

export const ledgerQuery = pageQuerySchema;

export const periodQuery = z.object({ period: periodSchema });
export const accrueSchema = z.object({ period: periodSchema });

export const paySchema = z.object({
  employeeId: uuid,
  /** SALARY pays what the company owes. ADVANCE gives money before it is earned (it is taken off the next salaries). */
  kind: z.enum(['SALARY', 'ADVANCE']),
  amount: cents,
  financialAccountId: uuid,
  note: note.optional(),
  paidOn: dateOnlySchema.optional(),
});

export const adjustSchema = z.object({ employeeId: uuid, amount: signedCents, note });
export const voidEntrySchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export type EmployeeListQuery = z.infer<typeof employeeListQuery>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type SalaryInput = z.infer<typeof salarySchema>;
export type PayInput = z.infer<typeof paySchema>;
export type AdjustInput = z.infer<typeof adjustSchema>;