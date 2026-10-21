import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma, withTenant, withUser } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, forbidden, unauthorized } from '../../shared/errors.js';
import type { ChangePasswordInput, LoginInput, RegisterCompanyInput } from './auth.schemas.js';
import { hashPassword, spendTimeLikeARealCheck, verifyPassword } from './passwords.js';
import { seedCompanyDefaults } from '../company/company.default.js';
import { effectivePermissions, type Role } from './permissions.js';
import { hashToken, newOpaqueToken, signAccessToken } from './tokens.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const REUSE_GRACE_MS = 10_000;

export interface RequestInfo {
  userAgent?: string;
  ip?: string;
}

export interface Session {
  accessToken: string;
  /** Goes into an httpOnly cookie. Never put it in a JSON response. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface SessionResult {
  session: Session;
  user: { id: string; name: string; email: string };
  company: { id: string; name: string };
  role: Role;
}

export type LoginResult =
  | ({ status: 'ok' } & SessionResult)
  | { status: 'choose_company'; companies: { id: string; name: string; role: Role }[] };

/** Creates a login session: a short-lived access token plus a stored refresh token. */
export async function startSession(userId: string, companyId: string, info: RequestInfo): Promise<Session> {
  const refreshToken = newOpaqueToken();
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      userId,
      activeCompanyId: companyId,
      tokenHash: hashToken(refreshToken), // only the hash is stored
      userAgent: info.userAgent?.slice(0, 300),
      expiresAt: refreshExpiresAt,
    },
  });
  return { accessToken: signAccessToken(userId, companyId), refreshToken, refreshExpiresAt };
}

/** Creates a brand-new company and its first Admin, and signs them in. */
export async function registerCompany(input: RegisterCompanyInput, info: RequestInfo): Promise<SessionResult> {
  if (!env.ALLOW_COMPANY_SIGNUP) throw forbidden('Creating new companies is turned off');
  if (await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })) {
    throw conflict('An account with this email already exists');
  }

  // We choose the ids ourselves so the database can be told "this transaction is for company X"
  // before the company row exists. Without that, company isolation would block creating it.
  const companyId = randomUUID();
  const userId = randomUUID();
  const passwordHash = await hashPassword(input.password);

  await withTenant({ companyId, userId }, async (tx) => {
    await tx.company.create({
      data: { id: companyId, name: input.companyName, legalName: input.companyName, country: input.country },
    });
    await tx.user.create({ data: { id: userId, email: input.email, name: input.adminName, passwordHash } });
    await tx.membership.create({ data: { companyId, userId, role: 'ADMIN' } });
    await seedCompanyDefaults(tx, companyId);
    await writeAudit(tx, {
      companyId,
      userId,
      action: 'company.registered',
      entityType: 'company',
      entityId: companyId,
      ip: info.ip,
    });
  });

  return {
    session: await startSession(userId, companyId, info),
    user: { id: userId, name: input.adminName, email: input.email },
    company: { id: companyId, name: input.companyName },
    role: 'ADMIN',
  };
}

export async function login(input: LoginInput, info: RequestInfo): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  // Same message and same timing whether the email exists or not.
  if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
    await spendTimeLikeARealCheck(input.password);
    throw unauthorized('Wrong email or password');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes.');
  }

  if (!(await verifyPassword(user.passwordHash, input.password))) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data:
        failed >= MAX_FAILED_LOGINS
          ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60 * 1000) }
          : { failedLogins: failed },
    });
    throw unauthorized('Wrong email or password');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  // Which companies does this person belong to?
  const memberships = await withUser(user.id, (tx) =>
    tx.membership.findMany({ where: { userId: user.id, status: 'ACTIVE' }, select: { companyId: true, role: true } }),
  );
  if (memberships.length === 0) throw forbidden('This account does not belong to any active company');

  const chosen = input.companyId
    ? memberships.find((m) => m.companyId === input.companyId)
    : memberships.length === 1
      ? memberships[0]
      : undefined;
  if (input.companyId && !chosen) throw forbidden('You do not belong to that company');

  if (!chosen) {
    // Several companies and none picked yet: tell the app to ask.
    const companies = await Promise.all(
      memberships.map(async (m) => ({
        id: m.companyId,
        role: m.role,
        name: (await withTenant({ companyId: m.companyId, userId: user.id }, (tx) =>
          tx.company.findUniqueOrThrow({ where: { id: m.companyId }, select: { name: true } }),
        )).name,
      })),
    );
    return { status: 'choose_company', companies };
  }

  const company = await withTenant({ companyId: chosen.companyId, userId: user.id }, async (tx) => {
    const c = await tx.company.findUniqueOrThrow({
      where: { id: chosen.companyId },
      select: { id: true, name: true, status: true },
    });
    if (c.status === 'ACTIVE') {
      await writeAudit(tx, {
        companyId: c.id,
        userId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
        ip: info.ip,
      });
    }
    return c;
  });
  if (company.status !== 'ACTIVE') throw forbidden('This company is not active');

  return {
    status: 'ok',
    session: await startSession(user.id, company.id, info),
    user: { id: user.id, name: user.name, email: user.email },
    company: { id: company.id, name: company.name },
    role: chosen.role,
  };
}

/** Swaps a refresh token for a new session. Each refresh token works exactly once. */
export async function refresh(rawToken: string | undefined, info: RequestInfo): Promise<Session> {
  if (!rawToken) throw unauthorized('Not signed in');
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!record) throw unauthorized('Not signed in');

  if (record.revokedAt) {
    // A used token was presented again. Right after use that is usually the app asking twice at once,
    // so we only refuse. Later, it may be a stolen copy, so every session of this user is ended.
    if (Date.now() - record.revokedAt.getTime() > REUSE_GRACE_MS) {
      await prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    throw unauthorized('Your session expired. Please sign in again.');
  }
  if (record.expiresAt < new Date()) throw unauthorized('Your session expired. Please sign in again.');

  // Is the person still allowed in?
  const membership = await withTenant({ companyId: record.activeCompanyId, userId: record.userId }, (tx) =>
    tx.membership.findUnique({
      where: { companyId_userId: { companyId: record.activeCompanyId, userId: record.userId } },
      select: { status: true, user: { select: { status: true } } },
    }),
  );
  if (!membership || membership.status !== 'ACTIVE' || membership.user.status !== 'ACTIVE') {
    await prisma.refreshToken.updateMany({ where: { id: record.id }, data: { revokedAt: new Date() } });
    throw unauthorized('Your access has been removed');
  }

  // Use up the old token. "Only if still unused" makes two simultaneous refreshes safe: one wins.
  const used = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (used.count === 0) throw unauthorized('Your session expired. Please sign in again.');

  return startSession(record.userId, record.activeCompanyId, info);
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Who am I, which company, and exactly what am I allowed to do. The app uses this to build its menus. */
export async function getMe(auth: AuthContext) {
  const { user, company } = await withTenant(auth, async (tx) => ({
    user: await tx.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { id: true, name: true, email: true },
    }),
    company: await tx.company.findUniqueOrThrow({
      where: { id: auth.companyId },
      select: { id: true, name: true, country: true, currency: true, timezone: true },
    }),
  }));

  return { 
    user,
    company,
    role: auth.role,
    locationIds: auth.locationIds,
    permissions: effectivePermissions(auth)
  };
}

/** Changing a password signs the person out everywhere else, then keeps this device signed in. */
export async function changePassword(auth: AuthContext, input: ChangePasswordInput, info: RequestInfo): Promise<Session> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw unauthorized('Your current password is wrong');
  }
  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });

  await withTenant(auth, (tx) =>
    writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: auth.userId,
      ip: info.ip,
    }),
  );
  return startSession(auth.userId, auth.companyId, info);
}