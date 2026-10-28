// Permissions are granular. Roles are presets. Each grant has a scope:
//   own      = only records the user created
//   location = records at the user's assigned location(s)
//   company  = the whole company
// The Admin can switch individual permissions on or off per user (extra / revoked).

export const ROLES = ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];
export type Scope = 'own' | 'location' | 'company';

export const PERMISSIONS = [
  'company.manage',
  'users.manage',
  'import.run',
  'products.view',
  'products.manage',
  'prices.manage',
  'records.delete',
  'sales.view',
  'sales.create',
  'sales.void',
  'sales.void_request',
  'sales.supply_other_location',
  'stock.view',
  'stock.receive',
  'stock.transfer',
  'stock.release',
  'stock.count',
  'stock.adjust_approve',
  'purchases.view',
  'purchases.manage',
  'customers.view',
  'customers.manage',
  'credit.manage',
  'suppliers.view',
  'suppliers.manage',
  'expenses.create',
  'expenses.approve',
  'cash.manage',
  'payroll.view',
  'payroll.manage',
  'cost.view',
  'accounting.view',
  'accounting.manage',
  'reports.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = ['records.delete'];
/** The permissions an Admin can switch on or off for one person (everything except the Admin-only ones). */
export const SWITCHABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY_PERMISSIONS.includes(p));

type Grants = Partial<Record<Permission, Scope>>;

const all = (): Grants => Object.fromEntries(PERMISSIONS.map((p) => [p, 'company'])) as Grants;

export const ROLE_PRESETS: Record<Role, Grants> = {
  ADMIN: all(),
  MANAGER: {
    'products.view': 'company',
    'products.manage': 'company',
    'sales.view': 'location',
    'sales.create': 'location',
    'sales.void': 'location',
    'sales.supply_other_location': 'company',
    'stock.view': 'company', // sees the whole company's stock, changes only own location
    'stock.receive': 'location',
    'stock.transfer': 'location',
    'stock.release': 'location',
    'stock.count': 'location',
    'stock.adjust_approve': 'location',
    'purchases.view': 'company',
    'purchases.manage': 'location',
    'customers.view': 'location',
    'customers.manage': 'location',
    'suppliers.view': 'company',
    'suppliers.manage': 'location',
    'expenses.create': 'location',
    'expenses.approve': 'location',
    'cash.manage': 'location',
    'reports.view': 'location',
  },
  STAFF: {
    'products.view': 'company',
    'sales.view': 'own',
    'sales.create': 'own',
    'sales.void_request': 'own',
    'stock.view': 'location',
    'customers.view': 'location',
    'reports.view': 'own',
  },
  VIEWER: {
    'products.view': 'company',
    'sales.view': 'company',
    'stock.view': 'company',
    'customers.view': 'company',
    'suppliers.view': 'company',
    'purchases.view': 'company',
    'payroll.view': 'company',
    'cost.view': 'company',
    'accounting.view': 'company',
    'reports.view': 'company',
  },
};

/** Permission templates the Admin picks for a new Staff user. They are not separate roles. */
export const STAFF_TEMPLATES: Record<'CASHIER' | 'WAREHOUSE', Permission[]> = {
  CASHIER: [],
  WAREHOUSE: ['stock.receive', 'stock.transfer', 'stock.release', 'stock.count'],
};

export interface Principal {
  userId: string;
  role: Role;
  locationIds: string[];
  extraPermissions: string[];
  revokedPermissions: string[];
}

export interface Target {
  locationId?: string;
  ownerUserId?: string;
}

/** The scope this user has for a permission, or null if they do not have it. */
export function scopeFor(p: Principal, perm: Permission): Scope | null {
  if (p.revokedPermissions.includes(perm)) return null;
  if (p.role !== 'ADMIN' && ADMIN_ONLY_PERMISSIONS.includes(perm)) return null;
  const preset = ROLE_PRESETS[p.role][perm];
  if (preset) return preset;
  // Switched on for this user by the Admin: limited to their own locations.
  if (p.extraPermissions.includes(perm)) return p.role === 'ADMIN' ? 'company' : 'location';
  return null;
}

/** Every permission this user really has right now, with its scope. Used to build menus and the Admin's screens. */
export function effectivePermissions(p: Principal): Record<string, Scope> {
  const result: Record<string, Scope> = {};
  for (const perm of PERMISSIONS) {
    const scope = scopeFor(p, perm);
    if (scope) result[perm] = scope;
  }
  return result;
}

/**
 * Can this user do `perm`, optionally on a specific record?
 * Without a target it answers "does the user have this permission at all".
 */
export function can(p: Principal, perm: Permission, target: Target = {}): boolean {
  const scope = scopeFor(p, perm);
  if (!scope) return false;
  if (scope === 'company') return true;
  if (scope === 'location') {
    return target.locationId === undefined || p.locationIds.includes(target.locationId);
  }
  return target.ownerUserId === undefined || target.ownerUserId === p.userId;
}

/** The approver of an action can never be the person who made it. */
export function canApprove(approverId: string, creatorId: string): boolean {
  return approverId !== creatorId;
}
