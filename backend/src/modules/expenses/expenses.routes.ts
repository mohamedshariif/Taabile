import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createExpenseSchema, expenseListQuery, voidExpenseSchema } from './expenses.schemas.js';
import * as expenses from './expenses.service.js';

// Who may do what (the service also checks WHICH place and account):
//   expenses.create   record and see costs (Manager: own places and own drawer, Admin: everything)
//   expenses.approve  cancel a cost (Manager: own places, Admin)
export const expensesRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];

expensesRouter.get('/',
  ...need('expenses.create'),
  asyncHandler(async (req, res) => {
  const q = expenseListQuery.safeParse(req.query);
  if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
  res.json(await expenses.listExpenses(getAuth(req), q.data));
}));
// Fixed paths stay above '/:id'.
expensesRouter.get('/categories',
  ...need('expenses.create'),
  asyncHandler(async (req, res) => res.json(await expenses.listCategories(getAuth(req))))
);
expensesRouter.get('/:id',
  ...need('expenses.create'),
  asyncHandler(async (req, res) => res.json(await expenses.getExpense(getAuth(req), uuidParam(req.params.id))))
);
expensesRouter.post('/',
  ...need('expenses.create'),
  validateBody(createExpenseSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await expenses.createExpense(getAuth(req), req.body, req.ip)))
);
expensesRouter.post('/:id/void',
  ...need('expenses.approve'),
  validateBody(voidExpenseSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await expenses.voidExpense(getAuth(req), uuidParam(req.params.id), req.body.reason, req.ip)))
);