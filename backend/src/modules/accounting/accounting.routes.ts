import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { AppError } from '../../shared/errors.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { journalListQuery, manualJournalSchema, periodListQuery, reverseJournalSchema } from './accounting.schemas.js';
import * as accounting from './accounting.service.js';

export const accountingRouter = Router();

// Reading needs accounting.view (Admin and Viewer). Changing needs accounting.manage (Admin).
const view = [authenticate, requirePermission('accounting.view')];
const manage = [authenticate, requirePermission('accounting.manage')];

accountingRouter.get('/accounts', ...view, asyncHandler(async (req, res) => res.json(await accounting.listAccounts(getAuth(req)))));

accountingRouter.get(
  '/periods',
  ...view,
  asyncHandler(async (req, res) => {
    const q = periodListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await accounting.listPeriods(getAuth(req), q.data.year));
  }),
);
accountingRouter.post('/periods/:id/lock', ...manage, asyncHandler(async (req, res) =>
  res.json(await accounting.lockPeriod(getAuth(req), uuidParam(req.params.id), req.ip))));
accountingRouter.post('/periods/:id/reopen', ...manage, asyncHandler(async (req, res) =>
  res.json(await accounting.reopenPeriod(getAuth(req), uuidParam(req.params.id), req.ip))));

accountingRouter.get(
  '/journals',
  ...view,
  asyncHandler(async (req, res) => {
    const q = journalListQuery.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', q.error.flatten().fieldErrors);
    res.json(await accounting.listJournals(getAuth(req), q.data));
  }),
);
accountingRouter.get('/journals/:id', ...view, asyncHandler(async (req, res) =>
  res.json(await accounting.getJournal(getAuth(req), uuidParam(req.params.id)))));

// Both creating routes are protected against double-submit with an Idempotency-Key header.
accountingRouter.post(
  '/journals',
  ...manage,
  validateBody(manualJournalSchema),
  idempotent,
  asyncHandler(async (req, res) => res.status(201).json(await accounting.postManualJournal(getAuth(req), req.body, req.ip))),
);
accountingRouter.post(
  '/journals/:id/reverse',
  ...manage,
  validateBody(reverseJournalSchema),
  idempotent,
  asyncHandler(async (req, res) =>
    res.status(201).json(await accounting.reverseEntry(getAuth(req), uuidParam(req.params.id), req.body, req.ip))),
);