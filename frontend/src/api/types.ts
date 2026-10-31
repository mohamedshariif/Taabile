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

// ── Money accounts (K1) ──
export interface MoneyAccount {
  id: string;
  name: string;
  type: 'CASH' | 'BANK';
  location: { id: string; name: string } | null;
  status: RecordStatus;
  ledgerCode: string;
  balance: string;
}

// ── Sales (K2) ──
export type FulfillmentStatus = 'PENDING' | 'PARTIAL' | 'COMPLETE';
export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';
export interface SaleSummary {
  id: string;
  number: string;
  status: 'POSTED' | 'VOIDED';
  type: 'RETAIL' | 'WHOLESALE';
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  location: { id: string; name: string; code: string };
  customer: { id: string; code: string; name: string } | null;
  soldAt: string;
  total: string;
  paidTotal: string;
}
export interface Sale extends SaleSummary {
  dueDate: string | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  owed: string;
  createdById: string;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  lines: {
    id: string;
    product: { id: string; sku: string; name: string; baseUnit: string };
    unit: { id: string; name: string; factor: string };
    quantity: string;
    quantityBase: string;
    unitPrice: string;
    discount: string;
    tax: string;
    lineTotal: string;
    allocations: { id: string; supplyLocation: { id: string; name: string; code: string }; qtyBase: string; qtyReleased: string; remaining: string }[];
  }[];
  payments: { id: string; number: string; method: string; account: string; amount: string; paidAt: string; status: string }[];
  releases: { id: string; location: { id: string; name: string }; releasedAt: string; note: string | null }[];
}
export interface SaleQuote {
  priceList: { id: string; name: string };
  type: 'RETAIL' | 'WHOLESALE';
  taxRate: string;
  lines: {
    productId: string;
    unitId: string;
    listPrice: string | null;
    unitPrice: string | null;
    lineTotal: string;
    tax: string;
    problem: string | null;
    belowCost: boolean;
    parts: { locationId: string; locationName: string; qtyBase: string; available: string; enough: boolean }[];
  }[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}
export interface PendingRelease {
  allocationId: string;
  supplyLocation: { id: string; name: string };
  sale: { id: string; number: string; soldAt: string; location: { id: string; name: string }; customer: { id: string; name: string } | null };
  product: { id: string; sku: string; name: string; baseUnit: string };
  qtyBase: string;
  qtyReleased: string;
  remaining: string;
}

// ── Payments (L) ──
export interface PaymentRecord {
  id: string;
  number: string;
  partyType: 'CUSTOMER' | 'SUPPLIER';
  customer: { id: string; code: string; name: string } | null;
  supplier: { id: string; code: string; name: string } | null;
  account: { id: string; name: string; type: 'CASH' | 'BANK' };
  method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  amount: string;
  paidAt: string;
  reference: string | null;
  status: 'POSTED' | 'VOIDED';
  note: string | null;
  createdById: string;
  allocations: { id: string; amount: string; document: { kind: 'SALE' | 'RECEIPT'; id: string; number: string } }[];
}
export interface OpenDocument {
  kind: 'SALE' | 'RECEIPT';
  id: string;
  number: string;
  date: string;
  dueDate: string | null;
  total: string;
  paid: string;
  owed: string;
  overdue: boolean;
}
export interface OpenDocuments {
  party: { id: string; name: string };
  balance: string;
  items: OpenDocument[];
}
export interface Statement {
  party: { kind: 'CUSTOMER' | 'SUPPLIER'; id: string; code: string; name: string };
  from: string | null;
  to: string | null;
  openingBalance: string;
  closingBalance: string;
  lines: { date: string; entry: string; description: string; document: { kind: string; id: string; number: string } | null; charge: string; paid: string; balance: string }[];
}

// ── Expenses and cash movements (M) ──
export interface Expense {
  id: string;
  number: string;
  category: { id: string; name: string };
  location: { id: string; name: string } | null;
  account: { id: string; name: string; type: 'CASH' | 'BANK' } | null;
  amount: string;
  incurredOn: string;
  description: string;
  status: 'POSTED' | 'VOIDED';
  createdById: string;
  approvedById: string | null;
}
export interface ExpensePage {
  items: Expense[];
  nextCursor: string | null;
  /** Total of the valid expenses matching the filter. */
  total: string;
}
export interface CashTransfer {
  id: string;
  number: string;
  type: 'DEPOSIT' | 'HANDOVER' | 'WITHDRAWAL' | 'TRANSFER';
  from: { id: string; name: string; type: 'CASH' | 'BANK' };
  to: { id: string; name: string; type: 'CASH' | 'BANK' };
  amount: string;
  received: string | null;
  difference: string;
  differenceNote: string | null;
  status: 'PENDING' | 'CONFIRMED';
  occurredAt: string;
  confirmedAt: string | null;
  createdById: string;
  confirmedById: string | null;
}
export interface CashChoice { id: string; name: string; type: 'CASH' | 'BANK'; place: string | null }
export interface CashCount {
  account: { id: string; name: string };
  expected: string;
  counted: string;
  difference: string;
  result: 'MATCH' | 'SHORTAGE' | 'OVERAGE';
  journalEntry: string | null;
}