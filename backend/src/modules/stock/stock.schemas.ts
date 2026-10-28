import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { tryD } from '../../shared/money.js';

const uuid = z.string().uuid();

/** A quantity the person typed, in the unit they chose: more than 0, up to 4 decimals. */
export const quantityField = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .superRefine((v, ctx) => {
    if (!/^\d{1,14}(\.\d{1,4})?$/.test(v)) ctx.addIssue({ code: 'custom', message: 'Enter a number with up to 4 decimals' });
    else if (tryD(v)!.lte(0)) ctx.addIssue({ code: 'custom', message: 'Quantity must be more than zero' });
  });

/** A cost per unit the person typed: 0 or more, up to 6 decimals. */
export const costField = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,13}(\.\d{1,6})?$/.test(v), 'Enter a cost with up to 6 decimals');

const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200);

export const openingSchema = z
  .object({
    locationId: uuid,
    lines: z
      .array(z.object({ productId: uuid, unitId: uuid.optional(), quantity: quantityField, unitCost: costField }))
      .min(1, 'Add at least one product')
      .max(200, 'At most 200 products at a time'),
    note: z.string().trim().max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.lines.map((l) => l.productId);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'The same product appears twice', path: ['lines'] });
  });

export const adjustmentSchema = z
  .object({
    locationId: uuid,
    productId: uuid,
    unitId: uuid.optional(),
    direction: z.enum(['IN', 'OUT']),
    kind: z.enum(['ADJUSTMENT', 'DAMAGE']).default('ADJUSTMENT'),
    quantity: quantityField,
    reason,
  })
  .refine((v) => v.kind !== 'DAMAGE' || v.direction === 'OUT', { message: 'Damaged or expired stock can only be taken out', path: ['direction'] });

export const reverseSchema = z.object({ reason });

export const stockListQuery = pageQuerySchema.extend({
  locationId: uuid.optional(),
  productId: uuid.optional(),
  categoryId: uuid.optional(),
  search: z.string().trim().max(80).optional(),
  inStock: z.enum(['true', 'false']).default('true'), // true = only products with something on hand
});

export const movementListQuery = pageQuerySchema.extend({
  locationId: uuid.optional(),
  productId: uuid.optional(),
  type: z.enum([
    'OPENING',
    'RECEIPT',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'SALE_RELEASE',
    'RETURN_IN',
    'RETURN_OUT',
    'ADJUSTMENT',
    'DAMAGE',
    'REVERSAL'
  ]).optional(),
});

export type OpeningInput = z.infer<typeof openingSchema>;
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;
export type StockListQuery = z.infer<typeof stockListQuery>;
export type MovementListQuery = z.infer<typeof movementListQuery>;