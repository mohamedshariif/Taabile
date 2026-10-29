import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { dateOnlySchema, moneyString } from '../../shared/schemas.js';

const uuid = z.string().uuid();
/** An amount of money in whole cents: at most 2 decimals, more than zero. */
const cents = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && D(v).gt(0), 'Enter an amount above zero, with at most 2 decimals');

const common = {
  financialAccountId: uuid,
  amount: cents,
  /** Bank transfer number, cheque number, mobile-money reference... */
  reference: z.string().trim().min(1).max(80).optional(),
  note: z.string().trim().min(1).max(300).optional(),
};
const noDuplicate = (key: 'saleId' | 'receiptId') => (v: { allocations?: Record<string, string>[] | undefined }) =>
  !v.allocations || new Set(v.allocations.map((a) => a[key])).size === v.allocations.length;

/** Money from a customer. Leave `allocations` out to pay the oldest invoices first. */
export const receiveSchema = z
  .object({
    customerId: uuid,
    ...common,
    allocations: z.array(z.object({ saleId: uuid, amount: cents })).min(1).max(100).optional(),
  })
  .refine(noDuplicate('saleId'), { message: 'The same invoice appears twice', path: ['allocations'] });

/** Money paid to a supplier. Leave `allocations` out to pay the oldest bills first. */
export const paySupplierSchema = z
  .object({
    supplierId: uuid,
    ...common,
    allocations: z.array(z.object({ receiptId: uuid, amount: cents })).min(1).max(100).optional(),
  })
  .refine(noDuplicate('receiptId'), { message: 'The same bill appears twice', path: ['allocations'] });

export const voidPaymentSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export const paymentListQuery = pageQuerySchema.extend({
  partyType: z.enum(['CUSTOMER', 'SUPPLIER']).optional(),
  customerId: uuid.optional(),
  supplierId: uuid.optional(),
  financialAccountId: uuid.optional(),
  status: z.enum(['POSTED', 'VOIDED']).optional(),
  search: z.string().trim().max(40).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

/** Exactly one of customerId / supplierId. */
export const partyQuery = z
  .object({ customerId: uuid.optional(), supplierId: uuid.optional() })
  .refine((v) => Number(!!v.customerId) + Number(!!v.supplierId) === 1, 'Give either customerId or supplierId');
export const statementQuery = z
  .object({ customerId: uuid.optional(), supplierId: uuid.optional(), from: dateOnlySchema.optional(), to: dateOnlySchema.optional() })
  .refine((v) => Number(!!v.customerId) + Number(!!v.supplierId) === 1, 'Give either customerId or supplierId');

export type ReceiveInput = z.infer<typeof receiveSchema>;
export type PaySupplierInput = z.infer<typeof paySupplierSchema>;
export type PaymentListQuery = z.infer<typeof paymentListQuery>;
export type StatementQuery = z.infer<typeof statementQuery>;