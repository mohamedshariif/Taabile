import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { closeSchema, createTransferSchema, dispatchSchema, receiveSchema, rejectSchema, transferListQuery } from './transfers.schemas.js';
import * as transfers from './transfers.service.js';

// Who may do what (the service also checks WHICH place the person works at):
//   stock.view      see transfers that start or end at a place they can see
//   stock.transfer  request, approve, reject, send and cancel (the sending place decides)
//   stock.receive   receive at the destination
//   stock.adjust_approve  close a transfer that arrived short (writes the missing goods off)
export const transfersRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];
const id = (req: { params: { id?: string | undefined } }) => uuidParam(req.params.id);

transfersRouter.get('/', ...need('stock.view'), asyncHandler(async (req, res) => {
  const q = transferListQuery.safeParse(req.query);
  if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
  res.json(await transfers.listTransfers(getAuth(req), q.data));
}));
transfersRouter.get('/:id', ...need('stock.view'), asyncHandler(async (req, res) => res.json(await transfers.getTransfer(getAuth(req), id(req)))));
transfersRouter.post('/', ...need('stock.transfer'), validateBody(createTransferSchema), idempotent, asyncHandler(async (req, res) => res.status(201).json(await transfers.createTransfer(getAuth(req), req.body, req.ip))));
transfersRouter.post('/:id/approve', ...need('stock.transfer'), idempotent, asyncHandler(async (req, res) => res.json(await transfers.approveTransfer(getAuth(req), id(req), req.ip))));
transfersRouter.post('/:id/reject', ...need('stock.transfer'), validateBody(rejectSchema), idempotent, asyncHandler(async (req, res) => res.json(await transfers.rejectTransfer(getAuth(req), id(req), req.body.reason, req.ip))));
transfersRouter.post('/:id/cancel', ...need('stock.transfer'), idempotent, asyncHandler(async (req, res) => res.json(await transfers.cancelTransfer(getAuth(req), id(req), req.ip))));
transfersRouter.post('/:id/dispatch', ...need('stock.transfer'), validateBody(dispatchSchema), idempotent, asyncHandler(async (req, res) => res.json(await transfers.dispatchTransfer(getAuth(req), id(req), req.body, req.ip))));
transfersRouter.post('/:id/receive', ...need('stock.receive'), validateBody(receiveSchema), idempotent, asyncHandler(async (req, res) => res.json(await transfers.receiveTransfer(getAuth(req), id(req), req.body, req.ip))));
transfersRouter.post('/:id/close', ...need('stock.adjust_approve'), validateBody(closeSchema), idempotent, asyncHandler(async (req, res) => res.json(await transfers.closeTransfer(getAuth(req), id(req), req.body.note, req.ip))));