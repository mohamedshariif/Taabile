import { env } from '../../config/env.js';
import { setContext, withInviteToken, withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { AppError, conflict, forbidden, notFound } from '../../shared/errors.js';
import { sendInvitationEmail } from '../../shared/mailer.js';
import { startSession, type RequestInfo, type SessionResult } from '../auth/auth.service.js';
import { hashPassword } from '../auth/passwords.js';
import { hashToken, newOpaqueToken } from '../auth/tokens.js';
import type { AcceptInvitationInput, CreateInvitationInput } from './invitations.schemas.js';
import { assertLocationsExist } from '../locations/locations.service.js';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

/** The status is worked out from the dates, so it can never disagree with them. */
export function invitationStatus(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): InvitationStatus {
  if (i.acceptedAt) return 'ACCEPTED';
  if (i.revokedAt) return 'REVOKED';
  if (i.expiresAt <= now) return 'EXPIRED';
  return 'PENDING';
}

// Unknown, used, revoked and expired links all give this same answer, so nobody can probe which tokens exist.
const invalidLink = () =>
  new AppError(400, 'INVITATION_INVALID', 'This invitation link is not valid any more. Ask your Admin for a new one.');

const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000);
const linkFor = (token: string) => `${env.APP_BASE_URL}/accept-invite?token=${token}`;
// In development the API also hands back the link, so you can test without opening the terminal.
const devLinkFor = (token: string) => (env.NODE_ENV === 'production' ? {} : { devLink: linkFor(token) });

type InvitationRow = Awaited<ReturnType<Tx['invitation']['findUniqueOrThrow']>>;

const present = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  locationIds: i.locationIds,
  status: invitationStatus(i),
  expiresAt: i.expiresAt,
  acceptedAt: i.acceptedAt,
  createdAt: i.createdAt,
});

/** Admin invites someone. The secret token exists only in the email (and devLink in development). */
export async function createInvitation(auth: AuthContext, input: CreateInvitationInput, _info: RequestInfo) {
  if (input.role === 'ADMIN' && auth.role !== 'ADMIN') throw forbidden('Only an Admin can invite another Admin');

  const locationIds = input.role === 'MANAGER' || input.role === 'STAFF' ? [...new Set(input.locationIds)] : [];
  const token = newOpaqueToken();
  const expiresAt = hoursFromNow(env.INVITE_HOURS);

  const { invitation, companyName, inviterName } = await withTenant(auth, async (tx) => {
    const company = await tx.company.findUniqueOrThrow({ 
      where: { id: auth.companyId }, 
      select: { name: true } 
    });
    const inviter = await tx.user.findUniqueOrThrow({ 
      where: { id: auth.userId }, 
      select: { name: true } 
    });
    await assertLocationsExist(tx, auth.companyId, locationIds);

    const existingUser = await tx.user.findUnique({ 
      where: { email: input.email }, 
      select: { id: true } 
    });
    if (existingUser) {
      const member = await tx.membership.findUnique({
        where: { companyId_userId: { companyId: auth.companyId, userId: existingUser.id } },
        select: { id: true },
      });
      if (member) throw conflict('This person already belongs to your company');
    }

    // Only one live link per email: older unused invitations for the same person are cancelled.
    await tx.invitation.updateMany({
      where: { companyId: auth.companyId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const invitation = await tx.invitation.create({
      data: {
        companyId: auth.companyId,
        email: input.email,
        role: input.role,
        locationIds,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: auth.userId,
      },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: invitation.id,
      after: { email: input.email, role: input.role, locationIds },
    });
    return { invitation, companyName: company.name, inviterName: inviter.name };
  });

  await sendInvitationEmail({
    to: invitation.email,
    companyName,
    inviterName,
    role: invitation.role,
    link: linkFor(token),
    expiresAt,
  });
  return { 
    invitation: present(invitation), 
    ...devLinkFor(token) 
  };
}

export async function listInvitations(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.invitation.findMany({ 
      where: { companyId: auth.companyId }, 
      orderBy: { createdAt: 'desc' }, take: 100 
    }),
  );
  return { invitations: rows.map(present) };
}

export async function revokeInvitation(auth: AuthContext, id: string) {
  return withTenant(auth, async (tx) => {
    const inv = await tx.invitation.findFirst({ 
      where: { id, companyId: auth.companyId } 
    });
    if (!inv) throw notFound('Invitation not found');
    if (inv.acceptedAt) throw conflict('This invitation was already accepted');
    if (!inv.revokedAt) {
      await tx.invitation.update({ 
        where: { id }, 
        data: { revokedAt: new Date() } 
      });
      await writeAudit(tx, {
        companyId: auth.companyId,
        userId: auth.userId,
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: id,
      });
    }
    return { 
      invitation: present(await tx.invitation.findUniqueOrThrow({ 
        where: { id } 
      })) };
  });
}

/** Makes a fresh link for an invitation that is still open or has expired. The old link stops working. */
export async function resendInvitation(auth: AuthContext, id: string) {
  const token = newOpaqueToken();
  const expiresAt = hoursFromNow(env.INVITE_HOURS);

  const { invitation, companyName, inviterName } = await withTenant(auth, async (tx) => {
    const inv = await tx.invitation.findFirst({ 
      where: { id, companyId: auth.companyId } 
    });
    if (!inv) throw notFound('Invitation not found');
    if (inv.acceptedAt) throw conflict('This invitation was already accepted');
    if (inv.revokedAt) throw conflict('This invitation was cancelled. Create a new one instead.');

    const updated = await tx.invitation.update({ 
      where: { id }, 
      data: { tokenHash: hashToken(token), expiresAt } 
    });
    const company = await tx.company.findUniqueOrThrow({ 
      where: { id: auth.companyId }, 
      select: { name: true } 
    });
    const inviter = await tx.user.findUniqueOrThrow({ 
      where: { id: auth.userId }, 
      select: { name: true } 
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'invitation.resent',
      entityType: 'invitation',
      entityId: id,
    });
    return { 
      invitation: updated, 
      companyName: company.name, 
      inviterName: inviter.name 
    };
  });

  await sendInvitationEmail({
    to: invitation.email,
    companyName,
    inviterName,
    role: invitation.role,
    link: linkFor(token),
    expiresAt,
  });
  return { invitation: present(invitation), ...devLinkFor(token) };
}

/** Public: what the invited person sees when they open the link, before choosing a password. */
export async function previewInvitation(token: string) {
  const tokenHash = hashToken(token);
  return withInviteToken(tokenHash, async (tx) => {
    const inv = await tx.invitation.findUnique({ 
      where: { tokenHash } 
    });
    if (!inv || invitationStatus(inv) !== 'PENDING') throw invalidLink();

    await setContext(tx, { companyId: inv.companyId }); // now that we know the company, its data is visible
    const company = await tx.company.findUniqueOrThrow({ 
      where: { id: inv.companyId }, 
      select: { name: true } 
    });
    const inviter = await tx.user.findUnique({ 
      where: { id: inv.invitedById }, 
      select: { name: true } 
    });
    const existing = await tx.user.findUnique({ 
      where: { email: inv.email }, 
      select: { id: true } 
    });
    return {
      email: inv.email,
      role: inv.role,
      companyName: company.name,
      inviterName: inviter?.name ?? null,
      expiresAt: inv.expiresAt,
      // true: the person must sign in first, then open the link again. false: they choose a name and password.
      accountExists: Boolean(existing),
    };
  });
}

/**
 * Public: the invited person joins. `callerUserId` is who is signed in on this request, if anyone.
 *   New person        -> sends name + password, an account is created.
 *   Existing account  -> must already be signed in as that account, so normal login protections apply.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
  callerUserId: string | undefined,
  info: RequestInfo,
): Promise<SessionResult> {
  const tokenHash = hashToken(input.token);
  // Hashing is slow on purpose, so it is done before the database transaction starts.
  const passwordHash = input.password ? await hashPassword(input.password) : undefined;

  const joined = await withInviteToken(tokenHash, async (tx) => {
    const inv = await tx.invitation.findUnique({ 
      where: { tokenHash } 
    });
    if (!inv || invitationStatus(inv) !== 'PENDING') throw invalidLink();
    await setContext(tx, { companyId: inv.companyId });

    // Claim the invitation first. If two requests arrive together, only one of them can claim it.
    const claimed = await tx.invitation.updateMany({
      where: { id: inv.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count === 0) throw invalidLink();

    const company = await tx.company.findUniqueOrThrow({ 
      where: { id: inv.companyId }, 
      select: { id: true, name: true, status: true } });
    if (company.status !== 'ACTIVE') throw forbidden('This company is not active');

    const existing = await tx.user.findUnique({ 
      where: { email: inv.email } 
    });
    let user: { id: string; name: string; email: string };

    if (existing) {
      if (callerUserId !== existing.id) {
        throw new AppError(401, 'LOGIN_REQUIRED', 'An account with this email already exists. Sign in first, then open the link again.');
      }
      if (existing.status !== 'ACTIVE') throw forbidden('This account is disabled');
      const already = await tx.membership.findUnique({
        where: { companyId_userId: { companyId: inv.companyId, userId: existing.id } },
        select: { id: true },
      });
      if (already) throw conflict('You already belong to this company');
      user = existing;
    } else {
      const missing: Record<string, string[]> = {};
      if (!input.name) missing.name = ['Enter your name'];
      if (!passwordHash) missing.password = ['Choose a password'];
      if (Object.keys(missing).length > 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid', missing);
      }
      user = await tx.user.create({ 
        data: { email: inv.email, name: input.name!, passwordHash: passwordHash! } 
      });
    }

    const membership = await tx.membership.create({
      data: { companyId: inv.companyId, userId: user.id, role: inv.role },
    });
    if (inv.locationIds.length > 0) {
      const valid = await tx.location.findMany({
        where: { companyId: inv.companyId, id: { in: inv.locationIds } },
        select: { id: true },
      });
      await tx.membershipLocation.createMany({
        data: valid.map((l) => ({ membershipId: membership.id, locationId: l.id, companyId: inv.companyId })),
      });
    }
    await writeAudit(tx, {
      companyId: inv.companyId,
      userId: user.id,
      action: 'invitation.accepted',
      entityType: 'invitation',
      entityId: inv.id,
      ip: info.ip,
    });
    return { 
      user, 
      company: { id: company.id, name: company.name }, 
      role: inv.role 
    };
  });

  return {
    session: await startSession(joined.user.id, joined.company.id, info),
    user: { id: joined.user.id, name: joined.user.name, email: joined.user.email },
    company: joined.company,
    role: joined.role,
  };
}