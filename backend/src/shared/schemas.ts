import { z } from 'zod';

/** Emails are stored lower-case, so "Ali@Shop.com" and "ali@shop.com" are the same person. */
export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254);

export const newPasswordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128, 'Use at most 128 characters');

export const nameSchema = z.string().trim().min(2, 'Enter a name').max(120);

export const moneyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,15}(\.\d{1,4})?$/.test(v), 'Enter an amount with up to 4 decimals');

/** A calendar date such as 2026-10-17 (no time, no time zone). */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a real date');

export const toDateOnly = (v: string): Date => new Date(`${v}T00:00:00Z`);
export const fromDateOnly = (d: Date): string => d.toISOString().slice(0, 10);