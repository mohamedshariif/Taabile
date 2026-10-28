import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { countListQuery, createCountSchema, rejectCountSchema } from './counts.schemas.js';
import * as counts from './counts.service.js';

// Who may do what (the service also checks WHICH place the person works at):
//   stock.view            see counts of places they can see
//   stock.count           submit a count at their own place
//   stock.adjust_approve  approve or reject a count (a different person than the counter, except the Admin)
export const countsRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];
const id = (req: { params: { id?: string | undefined } }) => uuidParam(req.params.id);

countsRouter.get('/', ...need('stock.view'), asyncHandler(async (req, res) => {
  const q = countListQuery.safeParse(req.query);
  if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
  res.json(await counts.listCounts(getAuth(req), q.data));
}));
countsRouter.get('/:id', ...need('stock.view'), asyncHandler(async (req, res) => res.json(await counts.getCount(getAuth(req), id(req)))));
countsRouter.post('/', ...need('stock.count'), validateBody(createCountSchema), idempotent, asyncHandler(async (req, res) => res.status(201).json(await counts.submitCount(getAuth(req), req.body, req.ip))));
countsRouter.post('/:id/approve', ...need('stock.adjust_approve'), idempotent, asyncHandler(async (req, res) => res.json(await counts.approveCount(getAuth(req), id(req), req.ip))));
countsRouter.post('/:id/reject', ...need('stock.adjust_approve'), validateBody(rejectCountSchema), idempotent, asyncHandler(async (req, res) => res.json(await counts.rejectCount(getAuth(req), id(req), req.body.reason, req.ip))));