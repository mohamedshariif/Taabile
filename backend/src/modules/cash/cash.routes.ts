import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { confirmTransferSchema, countSchema, createTransferSchema, transferListQuery } from './cash.schemas.js';
import * as cash from './cash.service.js';

// Who may do what (the service also checks WHICH drawer or bank account):
//   cash.manage  move, confirm and count money (Manager: own drawers, Admin: everything including banks)
export const cashRouter = Router();
const need = [authenticate, requirePermission('cash.manage')];

cashRouter.get('/accounts',
  ...need,
  asyncHandler(async (req, res) => res.json(await cash.chooseAccounts(getAuth(req))))
);
cashRouter.get('/transfers',
  ...need,
  asyncHandler(async (req, res) => {
  const q = transferListQuery.safeParse(req.query);
  if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
  res.json(await cash.listTransfers(getAuth(req), q.data));
}));
cashRouter.get('/transfers/:id',
  ...need,
  asyncHandler(async (req, res) => res.json(await cash.getTransfer(getAuth(req), uuidParam(req.params.id))))
);
cashRouter.post('/transfers',
  ...need,
  validateBody(createTransferSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await cash.createTransfer(getAuth(req), req.body, req.ip)))
);
cashRouter.post('/transfers/:id/confirm',
  ...need,
  validateBody(confirmTransferSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await cash.confirmTransfer(getAuth(req), uuidParam(req.params.id), req.body, req.ip)))
);
cashRouter.post('/counts',
  ...need,
  validateBody(countSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await cash.countAccount(getAuth(req), req.body, req.ip)))
);