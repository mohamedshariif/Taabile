import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { optionalText, partyCode, partyName, phoneField } from '../customers/customers.schemas.js';

const termsDays = z.number().int('Whole days only').min(0).max(365, 'At most 365 days');

export const createSupplierSchema = z.object({
  name: partyName,
  code: partyCode.optional(),
  phone: phoneField,
  address: optionalText(300),
  paymentTermsDays: termsDays.optional(),
});

export const updateSupplierSchema = z
  .object({
    name: partyName.optional(),
    code: partyCode.optional(),
    phone: phoneField,
    address: optionalText(300),
    paymentTermsDays: termsDays.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

export const supplierListQuery = pageQuerySchema.extend({
  search: z.string().trim().max(80).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type SupplierListQuery = z.infer<typeof supplierListQuery>;