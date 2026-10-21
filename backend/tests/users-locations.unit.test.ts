import { describe, expect, it } from 'vitest';
import { createLocationSchema, updateLocationSchema } from '../src/modules/locations/locations.schemas.js';
import { updateMemberSchema } from '../src/modules/users/users.schemas.js';

describe('location input rules', () => {
  it('turns the code into upper case and trims the name', () => {
    const r = createLocationSchema.parse({ name: '  Store A ', code: ' wh-1 ', type: 'WAREHOUSE' });
    expect(r).toEqual({ name: 'Store A', code: 'WH-1', type: 'WAREHOUSE' });
  });
  it('rejects odd codes and unknown types', () => {
    expect(createLocationSchema.safeParse({ name: 'Store A', code: 'A B', type: 'STORE' }).success).toBe(false);
    expect(createLocationSchema.safeParse({ name: 'Store A', code: '', type: 'STORE' }).success).toBe(false);
    expect(createLocationSchema.safeParse({ name: 'Store A', code: 'A', type: 'SHOP' }).success).toBe(false);
  });
  it('an update must change something, and cannot change code or type', () => {
    expect(updateLocationSchema.safeParse({}).success).toBe(false);
    expect(updateLocationSchema.parse({ name: 'Main store', code: 'ZZ', type: 'WAREHOUSE' })).toEqual({ name: 'Main store' });
  });
});

describe('member update rules', () => {
  it('needs at least one field', () => {
    expect(updateMemberSchema.safeParse({}).success).toBe(false);
  });
  it('only accepts permissions that really exist', () => {
    expect(updateMemberSchema.safeParse({ extraPermissions: ['cost.view'] }).success).toBe(true);
    expect(updateMemberSchema.safeParse({ extraPermissions: ['rule.the.world'] }).success).toBe(false);
  });
  it('a permission cannot be switched on and off together', () => {
    expect(updateMemberSchema.safeParse({ extraPermissions: ['cost.view'], revokedPermissions: ['cost.view'] }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ extraPermissions: ['cost.view'], revokedPermissions: ['sales.create'] }).success).toBe(true);
  });
  it('rejects an unknown role', () => {
    expect(updateMemberSchema.safeParse({ role: 'OWNER' }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ role: 'STAFF' }).success).toBe(true);
  });
});