import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { tryD } from '../../shared/money.js';
import { quantityField } from '../stock/stock.schemas.js';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date');

/** Price per unit the supplier charges: 0 or more, up to 4 decimals (the supplier invoice has cents). */
const priceField = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,13}(\.\d{1,4})?$/.test(v), 'Enter a price with up to 4 decimals');

/** A landed cost amount: more than 0, up to 4 decimals. */
const amountField = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .superRefine((v, ctx) => {
    if (!/^\d{1,13}(\.\d{1,4})?$/.test(v)) ctx.addIssue({ code: 'custom', message: 'Enter an amount with up to 4 decimals' });
    else if (tryD(v)!.lte(0)) ctx.addIssue({ code: 'custom', message: 'Amount must be more than zero' });
  });

const optionalQty = quantityField.optional();
const text = (max: number) => z.string().trim().min(1).max(max).optional();

export const createReceiptSchema = z
  .object({
    supplierId: uuid,
    locationId: uuid,
    receivedAt: isoDate.optional(), // default today
    containerRef: text(60),
    supplierInvoiceRef: text(60),
    invoiceDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    note: text(300),
    lines: z
      .array(
        z.object({
          productId: uuid,
          unitId: uuid.optional(),
          qtyReceived: quantityField, // accepted into stock
          qtyExpected: optionalQty, // what the paperwork said (default = received)
          qtyDamaged: optionalQty, // arrived broken: not stocked, not paid for
          unitPrice: priceField, // per chosen unit
        }),
      )
      .min(1, 'Add at least one product')
      .max(200, 'At most 200 products at a time'),
    costs: z
      .array(
        z.object({
          type: z.enum(['FREIGHT', 'HANDLING', 'CONTAINER', 'OTHER']),
          amount: amountField,
          paidFromAccountId: uuid.optional(), // money account it was paid from; empty = still owed to the supplier
          note: text(120),
        }),
      )
      .max(10, 'At most 10 landed costs')
      .default([]),
  })
  .superRefine((v, ctx) => {
    const ids = v.lines.map((l) => `${l.productId}:${l.unitId ?? ''}`);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'The same product and unit appear twice', path: ['lines'] });
    if (v.invoiceDate && v.dueDate && v.dueDate < v.invoiceDate) ctx.addIssue({ code: 'custom', message: 'The due date is before the invoice date', path: ['dueDate'] });
  });

export const voidReceiptSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export const receiptListQuery = pageQuerySchema.extend({
  supplierId: uuid.optional(),
  locationId: uuid.optional(),
  status: z.enum(['POSTED', 'VOIDED', 'ALL']).default('ALL'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(60).optional(), // receipt number, invoice ref or container
});

export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;
export type ReceiptListQuery = z.infer<typeof receiptListQuery>;