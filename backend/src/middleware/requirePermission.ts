import type { RequestHandler } from 'express';
import { can, type Permission } from '../modules/auth/permissions.js';
import { forbidden, unauthorized } from '../shared/errors.js';

export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!can(req.auth, permission)) return next(forbidden());
    next();
  };