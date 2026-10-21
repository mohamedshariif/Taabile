import { Prisma, PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export type Tx = Prisma.TransactionClient;

export interface TenantContext {
  companyId: string;
  userId: string;
}

/**
 * Tells the database who is asking, for this transaction only.
 *   app.company_id        -> only this company's rows are visible
 *   app.user_id           -> lets a person list their own memberships before choosing a company
 *   app.invite_token_hash -> lets an invitation be found by its token before any company is known
 * The `true` makes them transaction-local, so they can never leak into another request.
 */
export async function setContext(
  tx: Tx,
  ctx: { companyId?: string; userId?: string; inviteTokenHash?: string },
): Promise<void> {
  if (ctx.companyId) await tx.$executeRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
  if (ctx.userId) await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
  if (ctx.inviteTokenHash) await tx.$executeRaw`SELECT set_config('app.invite_token_hash', ${ctx.inviteTokenHash}, true)`;
}

async function run<T>(ctx: Parameters<typeof setContext>[1], fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await setContext(tx, ctx);
      return fn(tx);
    },
    { timeout: 15_000 },
  );
}

/**
 * Every request that touches company data runs inside this. One database transaction per business
 * event: the document, stock movement and journal entry commit together or not at all.
 */
export const withTenant = <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => run(ctx, fn);

/** For things a person does before choosing a company (for example, listing their companies at login). */
export const withUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => run({ userId }, fn);

/** For opening an invitation by its secret token. Inside, call setContext() once the company is known. */
export const withInviteToken = <T>(inviteTokenHash: string, fn: (tx: Tx) => Promise<T>) =>
  run({ inviteTokenHash }, fn);