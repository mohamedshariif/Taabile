import { z } from 'zod';
import { emailSchema, nameSchema, newPasswordSchema } from '../../shared/schemas.js';

export const registerCompanySchema = z.object({
  companyName: z.string().trim().min(2, 'Enter the company name').max(120),
  country: z.string().trim().min(2).max(60).default('South Sudan'),
  adminName: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
  // Only needed when one person belongs to several companies.
  companyId: z.string().uuid().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});

export type RegisterCompanyInput = z.infer<typeof registerCompanySchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;