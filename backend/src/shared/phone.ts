import { z } from 'zod';

/** Phone numbers are stored without spaces, dashes or brackets ("+211 912-345-678" -> "+211912345678"), so the same number always looks the same. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-().]/g, ''))
  .refine((v) => /^\+?\d{6,15}$/.test(v), 'Enter a phone number with 6 to 15 digits (a leading + is allowed)');