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


// ── Customers and suppliers (F) ──
export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  priceList: { id: string; name: string } | null;
  /** null = cash only (no credit allowed) */
  creditLimit: string | null;
  paymentTermsDays: number;
  status: RecordStatus;
  /** What they owe us right now. */
  balance: string;
  createdAt: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  paymentTermsDays: number;
  status: RecordStatus;
  /** What we owe them right now. */
  balance: string;
  createdAt: string;
}

export interface PartyPage<T> {
  items: T[];
  nextCursor: string | null;
}

// ── Stock and purchasing (G, H) ──
export type MovementType = 'OPENING' | 'RECEIPT' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'SALE_RELEASE' | 'RETURN_IN' | 'RETURN_OUT' | 'ADJUSTMENT' | 'DAMAGE' | 'REVERSAL';

export interface StockItem {
  id: string;
  location: { id: string; name: string; code: string };
  product: { id: string; sku: string; name: string; baseUnit: string; allowFractions: boolean; category: { id: string; name: string } | null };
  onHand: string;
  committed: string;
  available: string;
  /** For example [{ name: 'Sack 50 kg', quantity: '2' }] */
  packages: { name: string; quantity: string }[];
  /** null when this person may not see costs */
  avgCost: string | null;
  value: string | null;
}

export interface StockMovement {
  id: string;
  seq: string;
  occurredAt: string;
  location: { id: string; name: string };
  product: { id: string; sku: string; name: string; baseUnit: string };
  type: MovementType;
  quantity: string;
  unitCost: string | null;
  totalCost: string | null;
  refType: string;
  refId: string | null;
  reason: string | null;
  reversalOfId: string | null;
  reversed: boolean;
}

export interface ReceiptSummary {
  id: string;
  number: string;
  status: 'POSTED' | 'VOIDED';
  supplier: { id: string; code: string; name: string };
  location: { id: string; name: string; code: string };
  receivedAt: string;
  supplierInvoiceRef: string | null;
  containerRef: string | null;
  goodsTotal: string;
  costTotal: string;
  total: string;
  paidTotal: string;
}

export interface Receipt extends Omit<ReceiptSummary, 'supplierInvoiceRef' | 'containerRef'> {
  supplierInvoiceRef: string | null;
  containerRef: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  note: string | null;
  lines: {
    id: string;
    product: { id: string; sku: string; name: string; baseUnit: string };
    unit: { id: string; name: string };
    qtyExpected: string;
    qtyReceived: string;
    qtyDamaged: string;
    qtyReceivedBase: string;
    unitPrice: string;
    lineTotal: string;
    landedUnitCostBase: string;
  }[];
  costs: { id: string; type: 'FREIGHT' | 'HANDLING' | 'CONTAINER' | 'OTHER'; amount: string; note: string | null }[];
}


// ── Transfers and counts (I) ──
export type TransferStatus = 'REQUESTED' | 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED' | 'DISCREPANCY' | 'CLOSED' | 'REJECTED' | 'CANCELLED';
export interface TransferSummary {
  id: string;
  number: string;
  status: TransferStatus;
  from: { id: string; name: string; code: string };
  to: { id: string; name: string; code: string };
  requestedAt: string;
  products: number;
}
export interface Transfer extends Omit<TransferSummary, 'products'> {
  dispatchedAt: string | null;
  receivedAt: string | null;
  note: string | null;
  lines: { id: string; product: { id: string; sku: string; name: string; baseUnit: string }; qtyRequested: string; qtyDispatched: string; qtyReceived: string; discrepancyNote: string | null }[];
}
export interface CountSummary {
  id: string;
  number: string;
  status: 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  location: { id: string; name: string; code: string };
  countedAt: string;
  products: number;
}
export interface StockCount extends Omit<CountSummary, 'products'> {
  countedById: string;
  approvedAt: string | null;
  note: string | null;
  lines: { id: string; product: { id: string; sku: string; name: string; baseUnit: string }; expectedQty: string; countedQty: string; difference: string; reason: string | null }[];
}