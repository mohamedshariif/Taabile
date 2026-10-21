import { Router } from 'express';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { requestInfo } from '../auth/session.http.js';
import { updateMemberSchema } from './users.schemas.js';
import * as users from './users.service.js';

export const usersRouter = Router();

// Every route in this file needs a signed-in person who has the users.manage permission.
usersRouter.use(authenticate, requirePermission('users.manage'));

// Must come before '/:userId', otherwise "catalog" would be read as a user id.
usersRouter.get('/catalog', (_req, res) => {
  res.json(users.permissionCatalog());
});

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await users.listMembers(getAuth(req)));
  }),
);

usersRouter.get(
  '/:userId',
  asyncHandler(async (req, res) => {
    res.json(await users.getMember(getAuth(req), uuidParam(req.params.userId, 'user id')));
  }),
);

usersRouter.patch(
  '/:userId',
  validateBody(updateMemberSchema),
  asyncHandler(async (req, res) => {
    res.json(await users.updateMember(getAuth(req), uuidParam(req.params.userId, 'user id'), req.body, requestInfo(req)));
  }),
);

usersRouter.post(
  '/:userId/deactivate',
  asyncHandler(async (req, res) => {
    res.json(await users.setMemberStatus(getAuth(req), uuidParam(req.params.userId, 'user id'), 'INACTIVE', requestInfo(req)));
  }),
);

usersRouter.post(
  '/:userId/reactivate',
  asyncHandler(async (req, res) => {
    res.json(await users.setMemberStatus(getAuth(req), uuidParam(req.params.userId, 'user id'), 'ACTIVE', requestInfo(req)));
  }),
);