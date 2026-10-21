import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { invitationsRouter } from './modules/invitations/invitations.routes.js';
import { locationsRouter } from './modules/locations/locations.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { accountingRouter } from './modules/accounting/accounting.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { companyRouter } from './modules/company/company.routes.js';

export function createApp(opts: { corsOrigin?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: opts.corsOrigin, credentials: true })); // credentials: lets the browser send the refresh cookie
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'taabile-api' });
  });

  // Feature modules are mounted here as they are built.
  app.use('/api/auth', authRouter);
  app.use('/api/invitations', invitationsRouter);
  app.use('/api/locations', locationsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/company', companyRouter);
  app.use('/api/accounting', accountingRouter);
  app.use('/api/audit-logs', auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}