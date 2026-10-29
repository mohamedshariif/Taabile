import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError, forbidden, unauthorized } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { scopeFor } from '../auth/permissions.js';
import { createMoneyAccountSchema, updateMoneyAccountSchema } from './money-accounts.schemas.js';
import * as accounts from './money-accounts.service.js';

// Who may do what (the service also checks WHICH place a cash drawer belongs to):
//   cash.manage      create and change cash drawers (Manager: own places) and bank accounts (Admin)
//   accounting.view  see every money account and its balance (Viewer)
export const moneyAccountsRouter = Router();

const mayView: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  return scopeFor(req.auth, 'cash.manage') || scopeFor(req.auth, 'accounting.view') ? next() : next(forbidden());
};
const mayManage: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  return scopeFor(req.auth, 'cash.manage') ? next() : next(forbidden());
};
const listQuery = z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE') });

moneyAccountsRouter.get(
  '/',
  authenticate,
  mayView,
  asyncHandler(async (req, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await accounts.listMoneyAccounts(getAuth(req), q.data.status));
}));
moneyAccountsRouter.get(
  '/:id',
  authenticate,
  mayView,
  asyncHandler(async (req, res) => res.json(await accounts.getMoneyAccount(getAuth(req), uuidParam(req.params.id))))
);
moneyAccountsRouter.post(
  '/',
  authenticate,
  mayManage,
  validateBody(createMoneyAccountSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await accounts.createMoneyAccount(getAuth(req), req.body, req.ip)))
);
moneyAccountsRouter.patch(
  '/:id',
  authenticate,
  mayManage,
  validateBody(updateMoneyAccountSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await accounts.updateMoneyAccount(getAuth(req), uuidParam(req.params.id), req.body, req.ip)))
);