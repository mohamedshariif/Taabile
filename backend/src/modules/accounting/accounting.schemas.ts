import type { Decimal } from 'decimal.js';
import { z } from 'zod';
import { D, tryD } from '../../shared/money.js';
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
  .refine(
    (l) => {
      const d = tryD(l.debit);
      const c = tryD(l.credit);
      if (!d || !c) return true; // the amount field already reported "not a number"
      return d.gt(0) !== c.gt(0);
    },
    {
      message: 'Each line needs either a debit or a credit amount, not both and not neither',
    },
  );

// An accountant's manual journal. Normal business events are posted automatically by the system.
export const manualJournalSchema = z
  .object({
    entryDate: dateOnlySchema,
    description: z.string().trim().min(3).max(200),
    lines: z.array(manualLine).min(2, 'A journal needs at least two lines').max(50),
  })
  .refine(
    (j) => {
      const debits = j.lines.map((l) => tryD(l.debit));
      const credits = j.lines.map((l) => tryD(l.credit));
      if (debits.includes(null) || credits.includes(null)) return true; // already reported on the line itself
      const sum = (xs: (Decimal | null)[]) => xs.reduce<Decimal>((a, x) => a.plus(x!), D(0));
      return sum(debits).equals(sum(credits));
    },
    { message: 'Total debits must equal total credits', path: ['lines'] },
  );

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