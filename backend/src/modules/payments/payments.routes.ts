import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { partyQuery, paymentListQuery, paySupplierSchema, receiveSchema, statementQuery, voidPaymentSchema } from './payments.schemas.js';
import * as payments from './payments.service.js';

// Who may do what (the service also checks WHICH cash drawer is used):
//   payments.view          see payments, what is still owed, and statements (Manager: their places, Admin and Viewer: all)
//   payments.receive       take money from a customer (Manager: into their own drawer or a bank account, Admin: any)
//   payments.pay_supplier  pay a supplier (same rule)
//   payments.void          cancel a payment (Admin only unless the Admin switches it on for someone)
export const paymentsRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];
const idOf = (req: { params: { id?: string | undefined } }) => uuidParam(req.params.id);
const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => { fieldErrors: unknown } } } }, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', r.error!.flatten().fieldErrors);
  return r.data as T;
};

paymentsRouter.get('/',
  ...need('payments.view'),
  asyncHandler(async (req, res) => res.json(await payments.listPayments(getAuth(req), parse(paymentListQuery, req.query))))
);
// Fixed paths stay above '/:id'.
paymentsRouter.get('/accounts',
  authenticate,
  asyncHandler(async (req, res) => res.json(await payments.usableAccounts(getAuth(req))))
);
paymentsRouter.get('/open',
  ...need('payments.view'),
  asyncHandler(async (req, res) => res.json(await payments.openDocuments(getAuth(req), parse(partyQuery, req.query))))
);
paymentsRouter.get('/statement',
  ...need('payments.view'),
  asyncHandler(async (req, res) => res.json(await payments.statement(getAuth(req), parse(statementQuery, req.query))))
);
paymentsRouter.get('/:id',
  ...need('payments.view'),
  asyncHandler(async (req, res) => res.json(await payments.getPayment(getAuth(req), idOf(req))))
);
paymentsRouter.post('/receive',
  ...need('payments.receive'),
  validateBody(receiveSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payments.receivePayment(getAuth(req), req.body, req.ip)))
);
paymentsRouter.post('/pay-supplier',
  ...need('payments.pay_supplier'),
  validateBody(paySupplierSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await payments.paySupplier(getAuth(req), req.body, req.ip)))
);
paymentsRouter.post('/:id/void',
  ...need('payments.void'),
  validateBody(voidPaymentSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await payments.voidPayment(getAuth(req), idOf(req), req.body.reason, req.ip)))
);