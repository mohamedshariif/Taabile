import { Router } from 'express';
import { authenticate, callerUserId, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { uuidParam, validateBody } from '../../shared/validate.js';
import { requestInfo, setRefreshCookie } from '../auth/session.http.js';
import { acceptInvitationSchema, createInvitationSchema } from './invitations.schemas.js';
import * as invitations from './invitations.service.js';

export const invitationsRouter = Router();

// ── Public: the invited person ──

invitationsRouter.get(
  '/by-token/:token',
  asyncHandler(async (req, res) => {
    res.json(await invitations.previewInvitation(String(req.params.token)));
  }),
);

invitationsRouter.post(
  '/accept',
  validateBody(acceptInvitationSchema),
  asyncHandler(async (req, res) => {
    const result = await invitations.acceptInvitation(req.body, callerUserId(req), requestInfo(req));
    setRefreshCookie(res, result.session);
    res.json({
      accessToken: result.session.accessToken,
      user: result.user,
      company: result.company,
      role: result.role,
    });
  }),
);

// ── Admin: manage invitations (needs the users.manage permission) ──

invitationsRouter.post(
  '/',
  authenticate,
  requirePermission('users.manage'),
  validateBody(createInvitationSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await invitations.createInvitation(getAuth(req), req.body, requestInfo(req)));
  }),
);

invitationsRouter.get(
  '/',
  authenticate,
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await invitations.listInvitations(getAuth(req)));
  }),
);

invitationsRouter.post(
  '/:id/revoke',
  authenticate,
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await invitations.revokeInvitation(getAuth(req), uuidParam(req.params.id)));
  }),
);

invitationsRouter.post(
  '/:id/resend',
  authenticate,
  requirePermission('users.manage'),
  asyncHandler(async (req, res) => {
    res.json(await invitations.resendInvitation(getAuth(req), uuidParam(req.params.id)));
  }),
);