import { z } from 'zod';

export const createLocationSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(80),
  // A short code printed on documents and used in reports, for example "A" or "WH". Cannot be changed later.
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,12}$/, 'Use 1 to 12 letters, numbers, - or _'),
  type: z.enum(['STORE', 'WAREHOUSE']),
});

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter a name').max(80).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, { message: 'Send a name or a status to change' });

export type CreateLocationInput = z.infer<typeof createLocationSchema>;
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;