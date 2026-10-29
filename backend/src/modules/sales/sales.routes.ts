import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createSaleSchema, paymentAccountsQuery, pendingQuery, quoteSaleSchema, releaseSchema, saleListQuery, voidSaleSchema } from './sales.schemas.js';
import * as sales from './sales.service.js';

// Who may do what (the service also checks WHICH place the person works at):
//   sales.view      see sales (Staff: their own, Manager: their place, Admin and Viewer: all)
//   sales.create    sell, from their own place (Admin: any place)
//   sales.discount  change a line's price (Manager, Admin)
//   sales.supply_other_location  take goods from another place on a sale (Manager, Admin)
//   stock.release   hand over goods that another place sold (the supplying place)
//   sales.void      cancel a sale (Manager: own place, Admin)
export const salesRouter = Router();
const need = (p: Parameters<typeof requirePermission>[0]) => [authenticate, requirePermission(p)];
const idOf = (req: { params: { id?: string | undefined } }) => uuidParam(req.params.id);
const parse = <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { flatten: () => { fieldErrors: unknown } } } }, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', r.error!.flatten().fieldErrors);
  return r.data as T;
};

salesRouter.get('/',
  ...need('sales.view'),
  asyncHandler(async (req, res) => res.json(await sales.listSales(getAuth(req), parse(saleListQuery, req.query))))
);
// These fixed paths must stay above '/:id'.
salesRouter.get('/pending-release',
  ...need('stock.release'),
  asyncHandler(async (req, res) => res.json(await sales.pendingReleases(getAuth(req), parse(pendingQuery, req.query).locationId)))
);
salesRouter.get('/payment-accounts',
  ...need('sales.create'),
  asyncHandler(async (req, res) => res.json(await sales.paymentAccounts(getAuth(req), parse(paymentAccountsQuery, req.query).locationId)))
);
salesRouter.post('/quote',
  ...need('sales.create'),
  validateBody(quoteSaleSchema),
  asyncHandler(async (req, res) => res.json(await sales.quoteSale(getAuth(req), req.body)))
);
salesRouter.get('/:id',
  ...need('sales.view'),
  asyncHandler(async (req, res) => res.json(await sales.getSale(getAuth(req), idOf(req))))
);
salesRouter.post('/',
  ...need('sales.create'),
  validateBody(createSaleSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await sales.createSale(getAuth(req), req.body, req.ip)))
);
salesRouter.post('/:id/release',
  ...need('stock.release'),
  validateBody(releaseSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await sales.releaseSale(getAuth(req), idOf(req), req.body, req.ip)))
);
salesRouter.post('/:id/void',
  ...need('sales.void'),
  validateBody(voidSaleSchema),
  idempotent,
  asyncHandler(async (req, res) => res.json(await sales.voidSale(getAuth(req), idOf(req), req.body.reason, req.ip)))
);