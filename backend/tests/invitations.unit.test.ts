import { describe, expect, it } from 'vitest';
import { acceptInvitationSchema, createInvitationSchema } from '../src/modules/invitations/invitations.schemas.js';
import { invitationStatus } from '../src/modules/invitations/invitations.service.js';

describe('invitationStatus', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const future = new Date('2026-10-17T12:00:00Z');
  const past = new Date('2026-10-10T12:00:00Z');

  it('is PENDING until it is used, cancelled, or runs out', () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: future }, now)).toBe('PENDING');
  });
  it('is EXPIRED once the time has passed', () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: past }, now)).toBe('EXPIRED');
    expect(invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: now }, now)).toBe('EXPIRED');
  });
  it('REVOKED and ACCEPTED win over the dates', () => {
    expect(invitationStatus({ acceptedAt: null, revokedAt: past, expiresAt: future }, now)).toBe('REVOKED');
    expect(invitationStatus({ acceptedAt: past, revokedAt: null, expiresAt: future }, now)).toBe('ACCEPTED');
  });
});

describe('invitation input rules', () => {
  it('cleans the email and defaults the locations to none', () => {
    const r = createInvitationSchema.parse({ email: '  Ali@Shop.COM ', role: 'MANAGER' });
    expect(r.email).toBe('ali@shop.com');
    expect(r.locationIds).toEqual([]);
  });
  it('rejects an unknown role and a bad location id', () => {
    expect(createInvitationSchema.safeParse({ email: 'a@b.com', role: 'OWNER' }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ email: 'a@b.com', role: 'STAFF', locationIds: ['nope'] }).success).toBe(false);
  });
  it('accepting needs a real-looking token and a 10+ character password when one is sent', () => {
    expect(acceptInvitationSchema.safeParse({ token: 'short' }).success).toBe(false);
    expect(acceptInvitationSchema.safeParse({ token: 'x'.repeat(43), name: 'Sara', password: 'tooshort' }).success).toBe(false);
    expect(acceptInvitationSchema.safeParse({ token: 'x'.repeat(43) }).success).toBe(true); // existing account: signed in instead
  });
});