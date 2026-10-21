import { z } from 'zod';
import { D } from '../../shared/money.js';
import { dateOnlySchema, moneyString } from '../../shared/schemas.js';
import { pageQuerySchema } from '../../shared/pagination.js';

const manualLine = z
  .object({
    accountId: z.string().uuid(),
    debit: moneyString.default('0'),
    credit: moneyString.default('0'),
    locationId: z.string().uuid().optional(),
    memo: z.string().trim().max(200).optional(),
  })
  .refine((l) => D(l.debit).gt(0) !== D(l.credit).gt(0), {
    message: 'Each line needs either a debit or a credit amount, not both and not neither',
  });

export const manualJournalSchema = z
  .object({
    entryDate: dateOnlySchema,
    description: z.string().trim().min(3).max(200),
    lines: z.array(manualLine).min(2, 'A journal needs at least two lines').max(50),
  })
  .refine((j) => j.lines.reduce((s, l) => s.plus(l.debit), D(0)).equals(j.lines.reduce((s, l) => s.plus(l.credit), D(0))), {
    message: 'Total debits must equal total credits',
    path: ['lines'],
  });

export const reverseJournalSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason').max(200),
  date: dateOnlySchema.optional(), // defaults to today
});

export const journalListQuery = pageQuerySchema.extend({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export const periodListQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export type ManualJournalInput = z.infer<typeof manualJournalSchema>;
export type ReverseJournalInput = z.infer<typeof reverseJournalSchema>;