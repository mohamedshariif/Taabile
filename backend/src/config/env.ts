import { z } from 'zod';

try {
  process.loadEnvFile('.env'); // Node 20.12+. Does not override variables already set.
} catch {
  // no .env file: rely on the real environment (production)
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  APP_BASE_URL: z.string().url(),

  // Login sessions
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),

  // Invitations
  INVITE_HOURS: z.coerce.number().int().positive().default(72),

  // Who may create a brand-new company. Turn off in production once your companies exist.
  ALLOW_COMPANY_SIGNUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const env = schema.parse(process.env);
