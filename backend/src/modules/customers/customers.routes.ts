import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createCustomerSchema, customerListQuery, updateCustomerSchema } from './customers.schemas.js';
import * as customers from './customers.service.js';

// Who may do what:
//   customers.view    see customers and what they owe (Admin, Manager, Staff, Viewer)
//   customers.manage  create and change customers (Admin, Manager)
//   credit.manage     set a credit limit or payment terms (Admin; can be switched on for one Manager)
//   records.delete    delete a customer created by mistake and never used (Admin only)
// Credit fields are checked inside the service because the same route is used with or without them.
const view = [authenticate, requirePermission('customers.view')];
const manage = [authenticate, requirePermission('customers.manage')];
const erase = [authenticate, requirePermission('records.delete')];

export const customersRouter = Router();

customersRouter.get(
  '/',
  ...view,
  asyncHandler(async (req, res) => {
    const q = customerListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await customers.listCustomers(getAuth(req), q.data));
  }),
);
customersRouter.get('/:id', ...view, asyncHandler(async (req, res) => res.json(await customers.getCustomer(getAuth(req), uuidParam(req.params.id)))));
customersRouter.post(
  '/',
  ...manage,
  validateBody(createCustomerSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await customers.createCustomer(getAuth(req), req.body, req.ip))),
);
customersRouter.patch(
  '/:id',
  ...manage,
  validateBody(updateCustomerSchema),
  asyncHandler(async (req, res) => res.json(await customers.updateCustomer(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);
customersRouter.delete('/:id', ...erase, asyncHandler(async (req, res) => res.json(await customers.deleteCustomer(getAuth(req), uuidParam(req.params.id), req.ip))));