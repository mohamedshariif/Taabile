import { Router } from 'express';
import { REFRESH_COOKIE, clearRefreshCookie, requestInfo, setRefreshCookie } from './session.http.js';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { validateBody } from '../../shared/validate.js';
import { changePasswordSchema, loginSchema, registerCompanySchema } from './auth.schemas.js';
import * as auth from './auth.service.js';

export const authRouter = Router();

authRouter.post(
  '/register-company',
  validateBody(registerCompanySchema),
  asyncHandler(async (req, res) => {
    const result = await auth.registerCompany(req.body, requestInfo(req));
    setRefreshCookie(res, result.session);
    res.status(201).json({
      accessToken: result.session.accessToken,
      user: result.user,
      company: result.company,
      role: result.role,
    });
  }),
);

authRouter.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await auth.login(req.body, requestInfo(req));
    if (result.status === 'choose_company') {
      res.json(result);
      return;
    }
    setRefreshCookie(res, result.session);
    res.json({
      status: 'ok',
      accessToken: result.session.accessToken,
      user: result.user,
      company: result.company,
      role: result.role,
    });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const session = await auth.refresh(req.cookies?.[REFRESH_COOKIE], requestInfo(req));
    setRefreshCookie(res, session);
    res.json({ accessToken: session.accessToken });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await auth.getMe(getAuth(req)));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const session = await auth.changePassword(getAuth(req), req.body, requestInfo(req));
    setRefreshCookie(res, session);
    res.json({ accessToken: session.accessToken });
  }),
);