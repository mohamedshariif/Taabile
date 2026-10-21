import type { Request } from 'express';
import { withTenant } from '../db/client.js';
import type { Principal } from '../modules/auth/permissions.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { asyncHandler } from '../shared/asyncHandler.js';
import { unauthorized } from '../shared/errors.js';

/** Everything the rest of the request needs to know about who is calling. */
export interface AuthContext extends Principal {
  companyId: string;
  membershipId: string;
}

function readClaims(req: Request) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  return token ? verifyAccessToken(token) : null;
}

/** For public routes that behave differently when the caller happens to be signed in. */
export const callerUserId = (req: Request): string | undefined => readClaims(req)?.userId;

export const authenticate = asyncHandler(async (req, _res, next) => {
  const claims = readClaims(req);
  if (!claims) throw unauthorized();
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  const found = await withTenant(claims, async (tx) => {
    const membership = await tx.membership.findUnique({
      where: { companyId_userId: { companyId: claims.companyId, userId: claims.userId } },
      include: { user: { select: { status: true } } },
    });
    if (!membership) return null;
    const locations = await tx.membershipLocation.findMany({
      where: { membershipId: membership.id },
      select: { locationId: true },
    });
    return { membership, locationIds: locations.map((l) => l.locationId) };
  });

  if (!found || found.membership.status !== 'ACTIVE' || found.membership.user.status !== 'ACTIVE') {
    throw unauthorized('Your session is no longer valid');
  }

  const auth: AuthContext = {
    userId: claims.userId,
    companyId: claims.companyId,
    membershipId: found.membership.id,
    role: found.membership.role,
    locationIds: found.locationIds,
    extraPermissions: found.membership.extraPermissions,
    revokedPermissions: found.membership.revokedPermissions,
  };
  req.auth = auth;
  next();
});

/** Use inside a handler that sits behind authenticate(). */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}