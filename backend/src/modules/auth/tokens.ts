import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';

export interface AccessClaims {
  userId: string;
  companyId: string;
}

export function signAccessToken(userId: string, companyId: string): string {
  return jwt.sign({ cid: companyId }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_MINUTES * 60, // seconds
  });
}

/** Returns the claims, or null if the token is missing, expired, tampered with, or the wrong shape. */
export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.cid !== 'string') return null;
    return { userId: payload.sub, companyId: payload.cid };
  } catch {
    return null;
  }
}

/** 32 random bytes, URL-safe. Used for refresh tokens and invitation links. */
export const newOpaqueToken = (): string => randomBytes(32).toString('base64url');

/** What we store instead of the token itself. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');