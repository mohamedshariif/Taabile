// The delete policy, written down as a test. If someone adds a table, or a DELETE permission, that does not
// fit the policy, this fails and says which one. No database needed: it reads prisma/schema.prisma and the SQL files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_PERMISSIONS, SWITCHABLE_PERMISSIONS, can, effectivePermissions, type Principal } from '../src/modules/auth/permissions.js';
import { updateMemberSchema } from '../src/modules/users/users.schemas.js';

const read = (f: string) => readFileSync(new URL(`../prisma/${f}`, import.meta.url), 'utf8');
const schema = read('schema.prisma');
const grants = read('grants.sql');
const constraints = read('constraints.sql');

// Tier A: never edited, never deleted (triggers + grants).
const APPEND_ONLY = ['journal_entries', 'journal_lines', 'stock_movements', 'audit_logs'];

// Tier A/B: the app can never delete these. Posted documents are voided; master records are switched off.
const NEVER_DELETE = [
  'companies', 'users', 'platform_admins', 'memberships', 'locations',
  'document_sequences', // deleting a counter would restart document numbers
  'sales', 'sale_lines', 'sale_line_allocations', 'sale_releases', 'sale_release_lines', 'sale_returns', 'sale_return_lines',
  'payments', 'payment_allocations', 'purchase_receipts', 'purchase_receipt_lines', 'purchase_costs',
  'transfers', 'transfer_lines', 'stock_counts', 'stock_count_lines', 'stock_balances',
  'funds_transfers', 'financial_accounts', 'expenses',
  'employees', 'salary_agreements', 'employee_ledger_entries', 'accounts', 'accounting_periods',
];

// Tier C1: master data that may be deleted by the Admin, but only while nothing refers to it (created by mistake).
const DELETE_IF_UNUSED = ['products', 'product_units', 'categories', 'price_lists', 'customers', 'suppliers', 'expense_categories'];

// Tier C2: working data with no accounting meaning.
const FREELY_DELETABLE = ['product_prices', 'membership_locations', 'invitations', 'refresh_tokens', 'idempotency_keys'];

const tableOf = (model: string, body: string) => body.match(/@@map\("(\w+)"\)/)?.[1] ?? model;
const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, table: tableOf(m[1]!, m[2]!), body: m[2]! }));
const list = (text: string) => text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

describe('delete policy', () => {
  it('every table is in exactly one tier (a new table must be classified on purpose)', () => {
    const tiers = { APPEND_ONLY, NEVER_DELETE, DELETE_IF_UNUSED, FREELY_DELETABLE };
    const all = Object.values(tiers).flat();
    expect(all.filter((t, i) => all.indexOf(t) !== i), 'listed in two tiers').toEqual([]);
    const tables = models.map((m) => m.table);
    expect(tables.filter((t) => !all.includes(t)), 'tables with no tier: add them to tests/delete-policy.test.ts').toEqual([]);
    expect(all.filter((t) => !tables.includes(t)), 'tiers mention tables that do not exist').toEqual([]);
  });

  it('grants.sql matches the policy exactly', () => {
    const noDelete = list(grants.match(/REVOKE DELETE, TRUNCATE ON([\s\S]*?)FROM taabile_app/)![1]!.replace(/--.*$/gm, ''));
    expect([...noDelete].sort()).toEqual([...NEVER_DELETE].sort());
    const ledgers = list(grants.match(/REVOKE UPDATE, DELETE, TRUNCATE ON([\s\S]*?)FROM taabile_app/)![1]!);
    expect([...ledgers].sort()).toEqual([...APPEND_ONLY].sort());
    // and nothing may ever truncate the deletable master tables either
    const noTruncate = list(grants.match(/REVOKE TRUNCATE ON([\s\S]*?)FROM taabile_app/)![1]!);
    for (const t of DELETE_IF_UNUSED) expect(noTruncate, t).toContain(t);
  });

  it('constraints.sql makes the ledgers append-only with triggers', () => {
    const arr = constraints.match(/FOREACH t IN ARRAY ARRAY\[([^\]]*)\]/)![1]!;
    expect([...list(arr.replace(/'/g, ''))].sort()).toEqual([...APPEND_ONLY].sort());
  });

  it('every link between tables refuses deletion (ON DELETE RESTRICT), so nothing is ever blanked or cascaded', () => {
    const relations = [...schema.matchAll(/@relation\([^)\n]*fields:[^)\n]*\)/g)].map((m) => m[0]);
    expect(relations.length).toBeGreaterThan(50);
    expect(relations.filter((r) => !r.includes('onDelete: Restrict')), 'relations without onDelete: Restrict').toEqual([]);
  });

  it('everything that is switched off instead of deleted has a status field', () => {
    const needStatus = ['companies', 'users', 'memberships', 'locations', 'products', 'product_units', 'categories', 'price_lists', 'customers', 'suppliers',
      'expense_categories', 'financial_accounts', 'employees', 'accounts'];
    for (const t of needStatus) {
      const m = models.find((x) => x.table === t)!;
      expect(/^\s+status\s+RecordStatus/m.test(m.body), `${t} needs a status field`).toBe(true);
    }
  });

  it('posted documents can be voided (a status), not deleted', () => {
    for (const t of ['sales', 'payments', 'expenses', 'purchase_receipts']) {
      const m = models.find((x) => x.table === t)!;
      expect(/^\s+status\s+DocStatus/m.test(m.body), `${t} needs a DocStatus`).toBe(true);
    }
  });
});

describe('permanent deletion is Admin-only', () => {
  const none = { extraPermissions: [], revokedPermissions: [] };
  const mk = (role: Principal['role'], extra: string[] = []): Principal => ({ userId: role, role, locationIds: [], ...none, extraPermissions: extra });

  it('only the Admin role has records.delete, and it cannot be switched on for anyone else', () => {
    expect(ADMIN_ONLY_PERMISSIONS).toContain('records.delete');
    expect(can(mk('ADMIN'), 'records.delete')).toBe(true);
    for (const r of ['MANAGER', 'STAFF', 'VIEWER'] as const) {
      expect(can(mk(r), 'records.delete'), r).toBe(false);
      expect(can(mk(r, ['records.delete']), 'records.delete'), `${r} with an extra switch`).toBe(false);
      expect(effectivePermissions(mk(r, ['records.delete']))).not.toHaveProperty('records.delete');
    }
    expect(effectivePermissions(mk('ADMIN'))).toHaveProperty('records.delete');
  });

  it('the permission screen never offers it, and the API refuses to store it', () => {
    expect(SWITCHABLE_PERMISSIONS).not.toContain('records.delete');
    expect(SWITCHABLE_PERMISSIONS).toContain('prices.manage');
    expect(updateMemberSchema.safeParse({ extraPermissions: ['records.delete'] }).success).toBe(false);
    expect(updateMemberSchema.safeParse({ extraPermissions: ['prices.manage'] }).success).toBe(true);
  });
});