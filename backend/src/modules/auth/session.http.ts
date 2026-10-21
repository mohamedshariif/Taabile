import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import type { RequestInfo, Session } from './auth.service.js';

// HTTP helpers for sessions, shared by every route file that signs someone in.

export const REFRESH_COOKIE = 'refresh_token';

const cookieBase = {
  httpOnly: true, // JavaScript in the browser can never read it
  secure: env.NODE_ENV === 'production', // HTTPS only in production
  sameSite: 'lax' as const, // not sent on cross-site POSTs
  path: '/api/auth', // only sent to the auth routes
};

export const setRefreshCookie = (res: Response, session: Session) =>
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...cookieBase, expires: session.refreshExpiresAt });

export const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, cookieBase);

export const requestInfo = (req: Request): RequestInfo => ({ userAgent: req.get('user-agent'), ip: req.ip });