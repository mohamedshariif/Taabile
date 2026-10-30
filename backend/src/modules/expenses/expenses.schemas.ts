import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { dateOnlySchema, moneyString } from '../../shared/schemas.js';

const uuid = z.string().uuid();
const cents = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && D(v).gt(0), 'Enter an amount above zero, with at most 2 decimals');

export const createExpenseSchema = z.object({
  categoryId: uuid,
  amount: cents,
  description: z.string().trim().min(3, 'Say what it was for (at least 3 characters)').max(200),
  /** Where the money came from: a cash drawer or bank account. */
  financialAccountId: uuid,
  /** Which place bears the cost. Leave out for a company-wide cost (Admin only). */
  locationId: uuid.optional(),
  /** The day it happened. Leave out for today. Not in the future. */
  incurredOn: dateOnlySchema.optional(),
});

export const voidExpenseSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export const expenseListQuery = pageQuerySchema.extend({
  status: z.enum(['POSTED', 'VOIDED']).optional(),
  locationId: uuid.optional(),
  categoryId: uuid.optional(),
  search: z.string().trim().max(60).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type ExpenseListQuery = z.infer<typeof expenseListQuery>;