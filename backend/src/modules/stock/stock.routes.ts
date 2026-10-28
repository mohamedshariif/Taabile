import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { adjustmentSchema, movementListQuery, openingSchema, reverseSchema, stockListQuery } from './stock.schemas.js';
import * as stock from './stock.service.js';

// Who may do what:
//   stock.view           see stock and its movements (Admin, Viewer: all locations; Manager: all; Staff: own locations)
//   cost.view            see costs and stock value (Admin, Viewer). Without it the cost fields come back empty.
//   import.run           enter opening stock (Admin only)
//   stock.adjust_approve adjust, write off, and reverse manual entries at one's own location (Admin, Manager)
const view = [authenticate, requirePermission('stock.view')];

export const stockRouter = Router();

stockRouter.get(
  '/',
  ...view,
  asyncHandler(async (req, res) => {
    const q = stockListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await stock.listStock(getAuth(req), q.data));
  }),
);

stockRouter.get(
  '/movements',
  ...view,
  asyncHandler(async (req, res) => {
    const q = movementListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await stock.listMovements(getAuth(req), q.data));
  }),
);

stockRouter.post(
  '/opening',
  authenticate,
  requirePermission('import.run'),
  validateBody(openingSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await stock.postOpening(getAuth(req), req.body, req.ip))),
);

stockRouter.post(
  '/adjustments',
  authenticate,
  requirePermission('stock.adjust_approve'),
  validateBody(adjustmentSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await stock.postAdjustment(getAuth(req), req.body, req.ip))),
);

// The permission depends on what is being reversed (opening stock needs import.run), so the service decides.
stockRouter.post(
  '/movements/:id/reverse',
  authenticate,
  validateBody(reverseSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await stock.reverseMovement(getAuth(req), uuidParam(req.params.id), req.body.reason, req.ip))),
);