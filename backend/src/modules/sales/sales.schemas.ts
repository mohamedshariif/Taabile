import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { dateOnlySchema, moneyString } from '../../shared/schemas.js';
import { quantityField } from '../stock/stock.schemas.js';

const uuid = z.string().uuid();

/** An amount of money in whole cents: at most 2 decimals, more than zero. */
const cents = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && D(v).gt(0), 'Enter an amount above zero, with at most 2 decimals');
/** A price: 0 or more, at most 4 decimals (a price per kilo can be small). */
const price = moneyString;

const saleLine = z.object({
  productId: uuid,
  unitId: uuid.optional(),
  quantity: quantityField,
  /** Leave out to use the price list. Typing a different price needs the discount permission. */
  unitPrice: price.optional(),
  /** Goods that come from another place: how much, in the same unit as `quantity`. The rest comes from the selling place. */
  fromOther: z.array(z.object({ locationId: uuid, quantity: quantityField })).max(10).optional(),
});

const base = z.object({
  locationId: uuid,
  customerId: uuid.optional(),
  type: z.enum(['RETAIL', 'WHOLESALE']).optional(),
  lines: z.array(saleLine).min(1, 'Add at least one product').max(100, 'At most 100 products on one sale'),
});

const noDuplicates = (v: { lines: { productId: string }[] }) => new Set(v.lines.map((l) => l.productId)).size === v.lines.length;

export const quoteSaleSchema = base.refine(noDuplicates, { message: 'The same product appears twice. Change its quantity instead.', path: ['lines'] });

export const createSaleSchema = base
  .extend({
    /** Money taken now. Whatever is not paid stays owed by the customer. */
    payments: z.array(z.object({ financialAccountId: uuid, amount: cents })).max(5).default([]),
    dueDate: dateOnlySchema.optional(),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .refine(noDuplicates, { message: 'The same product appears twice. Change its quantity instead.', path: ['lines'] });

export const releaseSchema = z.object({
  /** Leave out to release everything that is waiting at the places you work at. Quantities are in base units. */
  allocations: z.array(z.object({ allocationId: uuid, quantity: quantityField })).min(1).max(200).optional(),
  note: z.string().trim().min(1).max(200).optional(),
});

export const voidSaleSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export const saleListQuery = pageQuerySchema.extend({
  status: z.enum(['POSTED', 'VOIDED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID']).optional(),
  fulfillmentStatus: z.enum(['PENDING', 'PARTIAL', 'COMPLETE']).optional(),
  locationId: uuid.optional(),
  customerId: uuid.optional(),
  search: z.string().trim().max(40).optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
});

export const pendingQuery = z.object({ locationId: uuid.optional() });
export const paymentAccountsQuery = z.object({ locationId: uuid });

export type QuoteSaleInput = z.infer<typeof quoteSaleSchema>;
export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type ReleaseInput = z.infer<typeof releaseSchema>;
export type SaleListQuery = z.infer<typeof saleListQuery>;