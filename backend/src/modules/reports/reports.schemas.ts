import { z } from 'zod';
import { dateOnlySchema } from '../../shared/schemas.js';

const uuid = z.string().uuid();
const MAX_DAYS = 366;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** A date range (both ends included). Leave out `to` for today and `from` for 30 days back (the P&L: the start of the month). */
export const rangeQuery = z
  .object({ from: dateOnlySchema.optional(), to: dateOnlySchema.optional(), locationId: uuid.optional() })
  .superRefine((v, ctx) => {
    if (v.from && v.to) {
      if (v.from > v.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date cannot be before the start date' });
      else if (days(v.from, v.to) > MAX_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `Choose at most ${MAX_DAYS} days at a time` });
    }
  });

export const stockValueQuery = z.object({
  locationId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const owedQuery = z.object({ locationId: uuid.optional() });

export type RangeQuery = z.infer<typeof rangeQuery>;
export type StockValueQuery = z.infer<typeof stockValueQuery>;
export type OwedQuery = z.infer<typeof owedQuery>;
export { MAX_DAYS };