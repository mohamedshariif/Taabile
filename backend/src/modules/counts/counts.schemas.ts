import { z } from 'zod';
import { pageQuerySchema } from '../../shared/pagination.js';
import { quantityOrZero } from '../transfers/transfers.schemas.js';

const uuid = z.string().uuid();

export const createCountSchema = z
  .object({
    locationId: uuid,
    note: z.string().trim().min(1).max(300).optional(),
    lines: z
      .array(z.object({ productId: uuid, unitId: uuid.optional(), countedQty: quantityOrZero, reason: z.string().trim().min(3).max(200).optional() }))
      .min(1, 'Count at least one product')
      .max(500, 'At most 500 products at a time'),
  })
  .refine((v) => new Set(v.lines.map((l) => l.productId)).size === v.lines.length, { message: 'The same product appears twice', path: ['lines'] });

export const rejectCountSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(200) });

export const countListQuery = pageQuerySchema.extend({
  status: z.enum(['SUBMITTED', 'APPROVED', 'REJECTED']).optional(),
  locationId: uuid.optional(),
});

export type CreateCountInput = z.infer<typeof createCountSchema>;
export type CountListQuery = z.infer<typeof countListQuery>;