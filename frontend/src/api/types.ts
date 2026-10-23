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

// ── Products (F2) ──
export interface Category {
  id: string;
  name: string;
  status: RecordStatus;
  productCount: number;
}

export interface PriceList {
  id: string;
  name: string;
  kind: string;
  isDefault: boolean;
  status: RecordStatus;
}

export interface ProductUnit {
  id: string;
  name: string;
  /** How many BASE units one of these holds, as text: "50" for a sack of 50 kg. The base unit itself is "1". */
  factor: string;
  isBase: boolean;
  isPurchaseUnit: boolean;
  isSaleUnit: boolean;
  barcode: string | null;
  status: RecordStatus;
}

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  status: RecordStatus;
  category: { id: string; name: string } | null;
  baseUnit: string;
  allowFractions: boolean;
  units: ProductUnit[];
}

export interface ProductDetail extends ProductSummary {
  /** What can no longer change because the product has stock history. */
  locks: { baseUnitLocked: boolean; usedUnitIds: string[] };
  prices: { priceListId: string; unitId: string; price: string }[];
}

export interface ProductPage {
  items: ProductSummary[];
  nextCursor: string | null;
}