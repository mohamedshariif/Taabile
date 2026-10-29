import { z } from "zod";

const name = z.string().trim().min(2, 'Give it a name (at least 2 charcters').max(80, 'At most 80 characters');

export const createMoneyAccountSchema = z
  .object({
    name,
    type: z.enum(['CASH', 'BANK']),
    locationId: z.string().uuid().optional(),
  })
  .refine((v) => v.type !== 'CASH' || !!v.locationId, {
    message: 'A cash belongs to a place: choose which one',
    path: ['locationId']
  })
  .refine((v) => v.type !== 'BANK' || !v.locationId, {
    message: 'A bank account belongs to the company, not to one place',
    path: ['locationId']
  });

export const updateMoneyAccountSchema = z
  .object({
    name: name.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional()
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to chnage');

export type CreateMoneyAccountInput = z.infer<typeof createMoneyAccountSchema>;
export type UpdateMoneyAccountInput = z.infer<typeof updateMoneyAccountSchema>;