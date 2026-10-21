import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { createLocationSchema, updateLocationSchema } from './locations.schemas.js';
import * as locations from './locations.service.js';

export const locationsRouter = Router();

locationsRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await locations.listLocations(getAuth(req)));
  }),
);

locationsRouter.post(
  '/',
  authenticate,
  requirePermission('company.manage'),
  validateBody(createLocationSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await locations.createLocation(getAuth(req), req.body));
  }),
);

locationsRouter.patch(
  '/:id',
  authenticate,
  requirePermission('company.manage'),
  validateBody(updateLocationSchema),
  asyncHandler(async (req, res) => {
    res.json(await locations.updateLocation(getAuth(req), uuidParam(req.params.id), req.body));
  }),
);