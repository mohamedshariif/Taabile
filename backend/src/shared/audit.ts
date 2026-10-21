import type { Prisma } from '@prisma/client';
import type { Tx } from '../db/client.js';

export interface AuditEvent {
  companyId: string;
  userId?: string | null;
  action: string; // for example "invitation.created"
  entityType: string; // for example "invitation"
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
}

/** Never put passwords or tokens in here. */
export async function writeAudit(tx: Tx, e: AuditEvent): Promise<void> {
  await tx.auditLog.create({
    data: {
      companyId: e.companyId,
      userId: e.userId ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: e.before,
      after: e.after,
      ip: e.ip,
    },
  });
}