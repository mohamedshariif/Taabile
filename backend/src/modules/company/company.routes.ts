import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { validateBody } from '../../shared/validate.js';
import { updateCompanySchema } from './company.schemas.js';
import * as company from './company.service.js';

export const companyRouter = Router();

// Any member can read the company's basic settings (the app needs the name and time zone).
companyRouter.get('/', authenticate, asyncHandler(async (req, res) => res.json(await company.getCompany(getAuth(req)))));

companyRouter.patch(
  '/',
  authenticate,
  requirePermission('company.manage'),
  validateBody(updateCompanySchema),
  asyncHandler(async (req, res) => res.json(await company.updateCompany(getAuth(req), req.body, req.ip))),
);

companyRouter.post(
  '/setup-defaults',
  authenticate,
  requirePermission('company.manage'),
  asyncHandler(async (req, res) => res.json(await company.ensureDefaults(getAuth(req), req.ip))),
);