import type { Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../shared/errors.js';
import type { RequestInfo } from '../auth/auth.service.js';
import { PERMISSIONS, ROLES, ROLE_PRESETS, STAFF_TEMPLATES, can, effectivePermissions } from '../auth/permissions.js';
import { assertLocationsExist } from '../locations/locations.service.js';
import type { UpdateMemberInput } from './users.schemas.js';

// "Users" here means the people who belong to THIS company (their memberships).
// The same login can belong to several companies, each with its own role, stores and permissions.

const memberInclude = {
  user: { select: { name: true, email: true, lastLoginAt: true } },
  membershipLocations: { select: { locationId: true } },
} satisfies Prisma.MembershipInclude;

type MemberRow = Prisma.MembershipGetPayload<{ include: typeof memberInclude }>;

// Note what is NOT selected: passwordHash never leaves the database in these responses.
const present = (m: MemberRow) => ({
  userId: m.userId,
  name: m.user.name,
  email: m.user.email,
  role: m.role,
  status: m.status,
  locationIds: m.membershipLocations.map((l) => l.locationId),
  extraPermissions: m.extraPermissions,
  revokedPermissions: m.revokedPermissions,
  lastLoginAt: m.user.lastLoginAt,
  joinedAt: m.createdAt,
});

async function loadMember(tx: Tx, companyId: string, userId: string): Promise<MemberRow> {
  const member = await tx.membership.findUnique({
    where: { companyId_userId: { companyId, userId } },
    include: memberInclude,
  });
  if (!member) throw notFound('Member not found');
  return member;
}

/**
 * Makes everyone who changes people in this company take turns (the lock is released when the
 * transaction ends). Without it, two Admins could demote each other at the same moment and
 * the company would be left with no Admin at all.
 */
async function lockCompany(tx: Tx, companyId: string) {
  await tx.$queryRaw`SELECT id FROM companies WHERE id = ${companyId}::uuid FOR UPDATE`;
}

/** Re-reads who is acting, now that we hold the lock, so a stale token cannot act as an Admin who was just demoted. */
async function loadActor(tx: Tx, auth: AuthContext) {
  const actor = await tx.membership.findUnique({
    where: { companyId_userId: { companyId: auth.companyId, userId: auth.userId } },
    select: { role: true, status: true },
  });
  if (!actor || actor.status !== 'ACTIVE') throw unauthorized('Your session is no longer valid');
  return actor;
}

async function assertAnotherActiveAdmin(tx: Tx, companyId: string, exceptUserId: string) {
  const others = await tx.membership.count({
    where: { companyId, role: 'ADMIN', status: 'ACTIVE', userId: { not: exceptUserId }, user: { status: 'ACTIVE' } },
  });
  if (others === 0) throw conflict('The company must always have at least one active Admin');
}

/** Everything the Admin screen needs to build the permission switches. */
export function permissionCatalog() {
  return { roles: ROLES, permissions: PERMISSIONS, rolePresets: ROLE_PRESETS, staffTemplates: STAFF_TEMPLATES };
}

export async function listMembers(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.membership.findMany({ where: { companyId: auth.companyId }, include: memberInclude, orderBy: { createdAt: 'asc' } }),
  );
  return { members: rows.map(present) };
}

/** One person, plus exactly what they can do right now (role + switches), so the Admin can check it. */
const withPermissions = (m: MemberRow) => ({
  member: present(m),
  permissions: effectivePermissions({
    userId: m.userId,
    role: m.role,
    locationIds: m.membershipLocations.map((l) => l.locationId),
    extraPermissions: m.extraPermissions,
    revokedPermissions: m.revokedPermissions,
  }),
});

export async function getMember(auth: AuthContext, userId: string) {
  return withTenant(auth, async (tx) => withPermissions(await loadMember(tx, auth.companyId, userId)));
}

export async function updateMember(auth: AuthContext, userId: string, input: UpdateMemberInput, info: RequestInfo) {
  const changesAccess =
    input.role !== undefined || input.extraPermissions !== undefined || input.revokedPermissions !== undefined;
  if (changesAccess && userId === auth.userId) throw forbidden('You cannot change your own role or permissions');

  return withTenant(auth, async (tx) => {
    await lockCompany(tx, auth.companyId);
    const actor = await loadActor(tx, auth);
    const actorIsAdmin = actor.role === 'ADMIN';

    const current = await loadMember(tx, auth.companyId, userId);
    if (current.role === 'ADMIN' && !actorIsAdmin) throw forbidden('Only an Admin can change another Admin');
    if (!actorIsAdmin) {
      // Someone who was given users.manage can manage people, but cannot make Admins or hand out powers they lack.
      if (input.role === 'ADMIN') throw forbidden('Only an Admin can make someone an Admin');
      const notHeld = (input.extraPermissions ?? []).find((p) => !can(auth, p));
      if (notHeld) throw forbidden(`You cannot give a permission you do not have (${notHeld})`);
    }

    const role = input.role ?? current.role;
    const roleChanged = role !== current.role;
    if (current.role === 'ADMIN' && roleChanged && current.status === 'ACTIVE') {
      await assertAnotherActiveAdmin(tx, auth.companyId, userId);
    }

    // Admin and Viewer see the whole company, so they have no individual stores.
    const wholeCompany = role === 'ADMIN' || role === 'VIEWER';
    const locationIds = wholeCompany ? [] : [...new Set(input.locationIds ?? current.membershipLocations.map((l) => l.locationId))];
    await assertLocationsExist(tx, auth.companyId, locationIds);

    // Switches were tuned for the old role, so a role change starts them fresh unless new ones are sent.
    const extra = [...new Set(input.extraPermissions ?? (roleChanged ? [] : current.extraPermissions))];
    const revoked = [...new Set(input.revokedPermissions ?? (roleChanged ? [] : current.revokedPermissions))];
    if (extra.some((p) => revoked.includes(p))) throw badRequest('A permission cannot be switched on and off at the same time');

    await tx.membership.update({
      where: { id: current.id },
      data: { role, extraPermissions: extra, revokedPermissions: revoked },
    });
    await tx.membershipLocation.deleteMany({ where: { membershipId: current.id } });
    if (locationIds.length > 0) {
      await tx.membershipLocation.createMany({
        data: locationIds.map((locationId) => ({ membershipId: current.id, locationId, companyId: auth.companyId })),
      });
    }

    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'member.updated',
      entityType: 'membership',
      entityId: current.id,
      before: {
        userId,
        role: current.role,
        locationIds: current.membershipLocations.map((l) => l.locationId),
        extraPermissions: current.extraPermissions,
        revokedPermissions: current.revokedPermissions,
      },
      after: { userId, role, locationIds, extraPermissions: extra, revokedPermissions: revoked },
      ip: info.ip,
    });
    return withPermissions(await loadMember(tx, auth.companyId, userId));
  });
}

/**
 * Deactivating takes effect at once: every request re-checks the membership, and the person's
 * refresh tokens for this company are cancelled so they cannot start a new session either.
 */
export async function setMemberStatus(auth: AuthContext, userId: string, status: 'ACTIVE' | 'INACTIVE', info: RequestInfo) {
  if (status === 'INACTIVE' && userId === auth.userId) throw forbidden('You cannot deactivate yourself');

  return withTenant(auth, async (tx) => {
    await lockCompany(tx, auth.companyId);
    const actor = await loadActor(tx, auth);

    const current = await loadMember(tx, auth.companyId, userId);
    if (current.role === 'ADMIN' && actor.role !== 'ADMIN') throw forbidden('Only an Admin can change another Admin');
    if (current.status === status) return { member: present(current) }; // nothing to do

    if (status === 'INACTIVE' && current.role === 'ADMIN') {
      await assertAnotherActiveAdmin(tx, auth.companyId, userId);
    }
    await tx.membership.update({ where: { id: current.id }, data: { status } });
    if (status === 'INACTIVE') {
      await tx.refreshToken.updateMany({
        where: { userId, activeCompanyId: auth.companyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: status === 'INACTIVE' ? 'member.deactivated' : 'member.reactivated',
      entityType: 'membership',
      entityId: current.id,
      after: { userId },
      ip: info.ip,
    });
    return { member: present(await loadMember(tx, auth.companyId, userId)) };
  });
}