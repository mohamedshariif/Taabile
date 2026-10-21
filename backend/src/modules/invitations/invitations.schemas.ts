import { z } from 'zod';
import { emailSchema, nameSchema, newPasswordSchema } from '../../shared/schemas.js';

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['ADMIN', 'MANAGER', 'STAFF', 'VIEWER']),
  // Stores / the warehouse this person works at. 
  // Ignored for Admin and Viewer, who see the whole company.
  locationIds: z.array(z.string().uuid()).max(50).default([]),
});

export const acceptInvitationSchema = z.object({
  token: z.string().trim().min(20).max(200),
  // A brand-new person sends name + password. 
  // Someone who already has an account signs in first and sends neither.
  name: nameSchema.optional(),
  password: newPasswordSchema.optional(),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;