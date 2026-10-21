export type Role = 'ADMIN' | 'MANAGER' | 'STAFF' | 'VIEWER';
export type Scope = 'own' | 'location' | 'company';
export type LocationType = 'STORE' | 'WAREHOUSE';
export type RecordStatus = 'ACTIVE' | 'INACTIVE';

export interface Me {
  user: { id: string; name: string; email: string };
  company: { id: string; name: string; country: string; currency: string; timezone: string };
  role: Role;
  locationIds: string[];
  /** For example { "users.manage": "company", "sales.create": "location" } */
  permissions: Record<string, Scope>;
}

export interface CompanyChoice {
  id: string;
  name: string;
  role: Role;
}

export type LoginResponse =
  | { status: 'ok'; accessToken: string }
  | { status: 'choose_company'; companies: CompanyChoice[] };

export interface InvitationPreview {
  email: string;
  role: Role;
  companyName: string;
  inviterName: string | null;
  expiresAt: string;
  accountExists: boolean;
}

export interface Location {
  id: string;
  name: string;
  code: string;
  type: LocationType;
  status: RecordStatus;
  createdAt: string;
}

// ── Users and invitations (F1.3) ──
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: RecordStatus;
  locationIds: string[];
  extraPermissions: string[];
  revokedPermissions: string[];
  lastLoginAt: string | null;
  joinedAt: string;
}

export interface MemberDetail {
  member: Member;
  /** What this person can really do right now (role + switches). */
  permissions: Record<string, Scope>;
}

export interface PermissionCatalog {
  roles: Role[];
  permissions: string[];
  rolePresets: Record<Role, Record<string, Scope>>;
  staffTemplates: Record<string, string[]>;
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  locationIds: string[];
  status: InvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** In development the server also returns the link (there is no real email yet). */
export interface InvitationResult {
  invitation: Invitation;
  devLink?: string;
}