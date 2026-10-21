import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { AppError } from './errors.js';

export const validateBody =
  (schema: ZodTypeAny): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', result.error.flatten().fieldErrors));
    }
    req.body = result.data;
    next();
  };

/** Checks that a URL parameter such as /:id is a real UUID, so the database never sees garbage. */
export function uuidParam(value: string | undefined, name = 'id'): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${name}`);
  return result.data;
}