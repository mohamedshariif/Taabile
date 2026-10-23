import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createSupplierSchema, supplierListQuery, updateSupplierSchema } from './suppliers.schemas.js';
import * as suppliers from './suppliers.service.js';

// Who may do what:
//   suppliers.view    see suppliers and what we owe them (Admin, Manager, Viewer)
//   suppliers.manage  create and change suppliers (Admin, Manager)
//   records.delete    delete a supplier created by mistake and never used (Admin only)
const view = [authenticate, requirePermission('suppliers.view')];
const manage = [authenticate, requirePermission('suppliers.manage')];
const erase = [authenticate, requirePermission('records.delete')];

export const suppliersRouter = Router();

suppliersRouter.get(
  '/',
  ...view,
  asyncHandler(async (req, res) => {
    const q = supplierListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await suppliers.listSuppliers(getAuth(req), q.data));
  }),
);
suppliersRouter.get('/:id', ...view, asyncHandler(async (req, res) => res.json(await suppliers.getSupplier(getAuth(req), uuidParam(req.params.id)))));
suppliersRouter.post(
  '/',
  ...manage,
  validateBody(createSupplierSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await suppliers.createSupplier(getAuth(req), req.body, req.ip))),
);
suppliersRouter.patch(
  '/:id',
  ...manage,
  validateBody(updateSupplierSchema),
  asyncHandler(async (req, res) => res.json(await suppliers.updateSupplier(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);
suppliersRouter.delete('/:id', ...erase, asyncHandler(async (req, res) => res.json(await suppliers.deleteSupplier(getAuth(req), uuidParam(req.params.id), req.ip))));