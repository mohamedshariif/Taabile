import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { withTenant } from '../db/client.js';
import { asyncHandler } from '../shared/asyncHandler.js';
import { AppError } from '../shared/errors.js';
import { getAuth } from './authenticate.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;
const ABANDONED_AFTER_MS = 2 * 60 * 1000; // a claim with no answer after 2 minutes means the server died mid-request

const hashRequest = (req: Request) =>
  createHash('sha256').update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? {})}`).digest('hex');

export const idempotent: RequestHandler = asyncHandler(async (req, res, next) => {
  const auth = getAuth(req);
  const key = req.header('Idempotency-Key');
  if (!key || !KEY_FORMAT.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8 to 100 letters, numbers, - or _)');
  }
  const requestHash = hashRequest(req);

  const claim = await withTenant(auth, async (tx) => {
    // "DO NOTHING on conflict": if another request holds the key, we wait for it, then see count 0.
    const made = await tx.idempotencyKey.createMany({
      data: [{ companyId: auth.companyId, userId: auth.userId, key, requestHash }],
      skipDuplicates: true,
    });
    if (made.count === 1) return { state: 'new' as const };
    const row = await tx.idempotencyKey.findUniqueOrThrow({
      where: { companyId_key: { companyId: auth.companyId, key } },
    });
    if (row.requestHash !== requestHash) return { state: 'mismatch' as const };
    if (row.responseStatus !== null) return { state: 'replay' as const, status: row.responseStatus, body: row.responseBody };
    if (Date.now() - row.createdAt.getTime() > ABANDONED_AFTER_MS) {
      await tx.idempotencyKey.delete({ where: { id: row.id } });
      await tx.idempotencyKey.create({ data: { companyId: auth.companyId, userId: auth.userId, key, requestHash } });
      return { state: 'new' as const };
    }
    return { state: 'busy' as const };
  });

  if (claim.state === 'mismatch') {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
  }
  if (claim.state === 'busy') {
    throw new AppError(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed. Try again in a moment.');
  }
  if (claim.state === 'replay') {
    res.setHeader('Idempotent-Replay', 'true');
    res.status(claim.status).json(claim.body);
    return;
  }

  // New request: let the handler run, and watch what it answers.
  let captured: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    captured = body;
    return originalJson(body);
  };
  res.on('close', () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300 && captured !== undefined;
    withTenant(auth, async (tx) => {
      if (ok) {
        await tx.idempotencyKey.update({
          where: { companyId_key: { companyId: auth.companyId, key } },
          data: { responseStatus: res.statusCode, responseBody: captured as object },
        });
      } else {
        await tx.idempotencyKey.deleteMany({ where: { companyId: auth.companyId, key } });
      }
    }).catch((e) => console.error('idempotency bookkeeping failed', e));
  });
  next();
});