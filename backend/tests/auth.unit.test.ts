import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/auth/passwords.js';
import { hashToken, newOpaqueToken, signAccessToken, verifyAccessToken } from '../src/modules/auth/tokens.js';

describe('passwords', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong horse battery')).toBe(false);
  });

  it('never stores the plain password, and salts every hash differently', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');
    expect(a).not.toContain('same password here');
    expect(a.startsWith('$argon2id$')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('treats a damaged hash as "no", never as a crash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('tokens', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const companyId = '22222222-2222-4222-8222-222222222222';

  it('an access token carries the user and company', () => {
    expect(verifyAccessToken(signAccessToken(userId, companyId))).toEqual({ userId, companyId });
  });

  it('rejects garbage, a tampered token, a token signed with another secret, and an expired token', () => {
    const good = signAccessToken(userId, companyId);
    expect(verifyAccessToken('garbage')).toBeNull();
    expect(verifyAccessToken(good.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyAccessToken(jwt.sign({ cid: companyId }, 'another-secret-another-secret-1234', { subject: userId }))).toBeNull();
    expect(
      verifyAccessToken(
        jwt.sign({ cid: companyId }, process.env.JWT_SECRET!, { subject: userId, expiresIn: -10 }),
      ),
    ).toBeNull();
  });

  it('random tokens are unique, and the stored hash is stable and different from the token', () => {
    const a = newOpaqueToken();
    expect(a).not.toBe(newOpaqueToken());
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});