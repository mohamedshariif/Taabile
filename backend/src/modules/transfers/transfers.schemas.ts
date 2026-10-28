import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { quantityField } from '../stock/stock.schemas.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200);

/** A quantity that may be 0 (for example "none of this line was sent"): up to 4 decimals. */
export const quantityOrZero = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), 'Enter a number with up to 4 decimals (0 is allowed)');

const noDuplicates = (lines: { productId: string }[]) => new Set(lines.map((l) => l.productId)).size === lines.length;

export const createTransferSchema = z
  .object({
    fromLocationId: uuid,
    toLocationId: uuid,
    note: z.string().trim().min(1).max(300).optional(),
    lines: z.array(z.object({ productId: uuid, unitId: uuid.optional(), quantity: quantityField })).min(1, 'Add at least one product').max(100, 'At most 100 products at a time'),
  })
  .refine((v) => v.fromLocationId !== v.toLocationId, { message: 'Choose two different places', path: ['toLocationId'] })
  .refine((v) => noDuplicates(v.lines), { message: 'The same product appears twice', path: ['lines'] });

/** Sending: leave `lines` out to send exactly what was asked for; or say what really goes (0 = none of that line). */
export const dispatchSchema = z
  .object({ lines: z.array(z.object({ productId: uuid, unitId: uuid.optional(), quantity: quantityOrZero })).max(100).optional() })
  .refine((v) => !v.lines || noDuplicates(v.lines), { message: 'The same product appears twice', path: ['lines'] });

/**
 * Receiving: leave `lines` out when everything arrived; otherwise say what actually arrived for each product.
 * A line that arrived short needs a `note` saying what happened to the missing goods.
 */
export const receiveSchema = z
  .object({
    lines: z
      .array(z.object({ productId: uuid, unitId: uuid.optional(), quantity: quantityOrZero, note: z.string().trim().min(3, 'Say what happened (at least 3 characters)').max(200).optional() }))
      .max(100)
      .optional(),
  })
  .refine((v) => !v.lines || noDuplicates(v.lines), { message: 'The same product appears twice', path: ['lines'] });

export const rejectSchema = z.object({ reason });
/** Closing a transfer that arrived short writes the missing goods off. */
export const closeSchema = z.object({ note: z.string().trim().min(3, 'Say how it was settled (at least 3 characters)').max(200) });

export const transferListQuery = pageQuerySchema.extend({
  status: z.enum(['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'DISCREPANCY', 'CLOSED', 'REJECTED', 'CANCELLED']).optional(),
  locationId: uuid.optional(), // either end
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type DispatchInput = z.infer<typeof dispatchSchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type TransferListQuery = z.infer<typeof transferListQuery>;