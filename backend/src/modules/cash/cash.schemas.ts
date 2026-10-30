import { z } from 'zod';
import { D } from '../../shared/money.js';
import { pageQuerySchema } from '../../shared/pagination.js';
import { moneyString } from '../../shared/schemas.js';

const uuid = z.string().uuid();
const cents = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v) && D(v).gt(0), 'Enter an amount above zero, with at most 2 decimals');
/** An amount counted or received: zero is allowed (an empty drawer). */
const counted = moneyString.refine((v) => /^\d{1,15}(\.\d{1,2})?$/.test(v), 'Enter an amount with at most 2 decimals');
const note = z.string().trim().min(3, 'Write at least 3 characters').max(200);

export const createTransferSchema = z
  .object({ fromAccountId: uuid, toAccountId: uuid, amount: cents, note: note.optional() })
  .refine((v) => v.fromAccountId !== v.toAccountId, { message: 'Choose two different accounts', path: ['toAccountId'] });

/** The amount that really arrived. Leave out when it is the full amount. A different amount needs a note. */
export const confirmTransferSchema = z.object({ receivedAmount: counted.optional(), differenceNote: note.optional() });

export const transferListQuery = pageQuerySchema.extend({
  status: z.enum(['PENDING', 'CONFIRMED']).optional(),
  accountId: uuid.optional(),
});

export const countSchema = z.object({ financialAccountId: uuid, counted, note: note.optional() });

export type CreateTransferInput = z.infer<typeof createTransferSchema>;
export type ConfirmTransferInput = z.infer<typeof confirmTransferSchema>;
export type TransferListQuery = z.infer<typeof transferListQuery>;
export type CountInput = z.infer<typeof countSchema>;