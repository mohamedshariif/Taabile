import { Router } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { owedQuery, rangeQuery, stockValueQuery } from './reports.schemas.js';
import * as reports from './reports.service.js';

// Reports only read. Who sees what (the service also limits the rows to the person's places):
//   reports.view     sales report and the overview (Staff: own sales, Manager: own places, Admin and Viewer: everything)
//   accounting.view  profit and loss (Admin, Viewer: it comes from the whole ledger)
//   cost.view        value of stock (Admin, Viewer: it shows what goods cost)
//   payments.view    who owes us and whom we owe
export const reportsRouter = Router();

function parse<S extends ZodTypeAny>(schema: S, query: unknown): z.output<S> {
  const q = schema.safeParse(query);
  if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
  return q.data;
}

reportsRouter.get('/overview',
  authenticate,
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => res.json(await reports.overview(getAuth(req))))
);
reportsRouter.get('/sales',
  authenticate,
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => res.json(await reports.salesReport(getAuth(req), parse(rangeQuery, req.query))))
);
reportsRouter.get('/profit-loss',
  authenticate,
  requirePermission('accounting.view'),
  asyncHandler(async (req, res) => res.json(await reports.profitLoss(getAuth(req), parse(rangeQuery, req.query))))
);
reportsRouter.get('/stock-value',
  authenticate,
  requirePermission('cost.view'),
  asyncHandler(async (req, res) => res.json(await reports.stockValue(getAuth(req), parse(stockValueQuery, req.query))))
);
reportsRouter.get('/receivables',
  authenticate,
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => res.json(await reports.receivables(getAuth(req), parse(owedQuery, req.query))))
);
reportsRouter.get('/payables',
  authenticate,
  requirePermission('payments.view'),
  asyncHandler(async (req, res) => res.json(await reports.payables(getAuth(req), parse(owedQuery, req.query))))
);