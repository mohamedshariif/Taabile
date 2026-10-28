import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createReceiptSchema, receiptListQuery, voidReceiptSchema } from './purchases.schemas.js';
import * as purchases from './purchases.service.js';

// Who may do what:
//   purchases.view    see receipts, with the prices paid (Admin, Manager, Viewer)
//   purchases.manage  record and cancel receipts at one's own location (Admin, Manager)
const view = [authenticate, requirePermission('purchases.view')];

export const purchasesRouter = Router();

purchasesRouter.get(
  '/',
  ...view,
  asyncHandler(async (req, res) => {
    const q = receiptListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await purchases.listReceipts(getAuth(req), q.data));
  }),
);
purchasesRouter.get('/:id', ...view, asyncHandler(async (req, res) => res.json(await purchases.getReceipt(getAuth(req), uuidParam(req.params.id)))));
purchasesRouter.post(
  '/',
  authenticate,
  requirePermission('purchases.manage'),
  validateBody(createReceiptSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await purchases.createReceipt(getAuth(req), req.body, req.ip))),
);
purchasesRouter.post(
  '/:id/void',
  authenticate,
  requirePermission('purchases.manage'),
  validateBody(voidReceiptSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await purchases.voidReceipt(getAuth(req), uuidParam(req.params.id), req.body.reason, req.ip))),
);