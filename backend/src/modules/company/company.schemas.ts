/* Tax is a percentage (0 to 100, up to 4 decimals). Time zones are checked against the real list, so “Mars/Base” is rejected. */

import { z } from 'zod';
import { D } from '../../shared/money.js';

const taxRate = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && D(v).lte(100), 'Enter a percentage from 0 to 100');

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone, for example Africa/Juba');

export const updateCompanySchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().min(2).max(160).optional(),
    taxRate: taxRate.optional(),
    timezone: timezone.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });

export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;