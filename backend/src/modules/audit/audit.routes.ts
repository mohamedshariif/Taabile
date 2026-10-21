/* Who did what, newest first. Only Admins (company.manage) can read it. Passwords and tokens never go into the log, so there is nothing sensitive to leak here. */

import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db/client.js';
import { authenticate, getAuth } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { asyncHandler } from '../../shared/asyncHandler.js';
import { pageArgs, pageQuerySchema, toPage } from '../../shared/pagination.js';
import { AppError } from '../../shared/errors.js';

export const auditRouter = Router();

const querySchema = pageQuerySchema.extend({
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(60).optional(),
  userId: z.string().uuid().optional(),
});

auditRouter.get(
  '/',
  authenticate,
  requirePermission('company.manage'),
  asyncHandler(async (req, res) => {
    const auth = getAuth(req);
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid filter', parsed.error.flatten().fieldErrors);
    const q = parsed.data;

    const result = await withTenant(auth, async (tx) => {
      const rows = await tx.auditLog.findMany({
        where: {
          companyId: auth.companyId,
          ...(q.action ? { action: q.action } : {}),
          ...(q.entityType ? { entityType: q.entityType } : {}),
          ...(q.userId ? { userId: q.userId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(q),
      });
      const page = toPage(rows, q.limit);
      const userIds = [...new Set(page.items.map((r) => r.userId).filter((x): x is string => !!x))];
      const members = userIds.length
        ? await tx.membership.findMany({
            where: { companyId: auth.companyId, userId: { in: userIds } },
            select: { userId: true, user: { select: { name: true, email: true } } },
          })
        : [];
      const who = new Map(members.map((m) => [m.userId, m.user]));
      return {
        items: page.items.map((r) => ({
          id: r.id,
          at: r.createdAt,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          user: r.userId ? { id: r.userId, ...(who.get(r.userId) ?? { name: null, email: null }) } : null,
          before: r.before,
          after: r.after,
          ip: r.ip,
        })),
        nextCursor: page.nextCursor,
      };
    });
    res.json(result);
  }),
);