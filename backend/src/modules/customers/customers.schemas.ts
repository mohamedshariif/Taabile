import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { phoneSchema } from '../../shared/phone.js';
import { moneyString } from '../../shared/schemas.js';

// Empty text from a form box means "nothing": it is stored as null instead of an empty string.
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullish();

export const partyName = z.string().trim().min(2, 'Enter a name (at least 2 characters)').max(120);

// Uppercase letters, digits and . _ - only; the server upper-cases what you type.
export const partyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._-]{0,29}$/, 'Use up to 30 letters, numbers, . _ or -');

export const phoneField = z
  .union([z.literal(''), phoneSchema])
  .transform((v) => (v === '' ? null : v))
  .nullish();

const termsDays = z.number().int('Whole days only').min(0).max(365, 'At most 365 days');
const creditLimit = moneyString.nullable();

export const createCustomerSchema = z.object({
  name: partyName,
  code: partyCode.optional(),
  phone: phoneField,
  address: optionalText(300),
  priceListId: z.string().uuid().nullish(),
  creditLimit: creditLimit.optional(), // empty = no credit allowed; needs credit.manage to set
  paymentTermsDays: termsDays.optional(), // needs credit.manage to set
});

export const updateCustomerSchema = z
  .object({
    name: partyName.optional(),
    code: partyCode.optional(),
    phone: phoneField,
    address: optionalText(300),
    priceListId: z.string().uuid().nullable().optional(),
    creditLimit: creditLimit.optional(),
    paymentTermsDays: termsDays.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

export const customerListQuery = pageQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuery>;