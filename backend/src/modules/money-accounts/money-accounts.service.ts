import type { FinancialAccount } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { can, scopeFor } from '../auth/permissions.js';
import type { CreateMoneyAccountInput, UpdateMoneyAccountInput } from './money-accounts.schemas.js';

// Money accounts = the places money sits: a cash drawer in a store, a bank account, a mobile-money wallet.
// Rules in this file:
//  * Each one gets its own accounting account (a child of "Cash on hand" or "Bank accounts"), so its balance is read
//    straight from the ledger and can never drift from the books.
//  * A cash drawer belongs to one place; a bank account belongs to the company.
//  * Admin manages all. A Manager manages only the cash drawers of their own places.
//  * An account that still holds (or owes) money cannot be switched off. Accounts are never deleted.
//  * Who sees what: Admin and Viewer see all; a Manager sees the cash drawers of their own places.

type Row = FinancialAccount & { location: { id: string; name: string } | null };

const include = { location: { select: { id: true, name: true } }, ledgerAccount: { select: { code: true } } } as const;

async function balances(tx: Tx, companyId: string, ledgerIds: string[]) {
  const out = new Map<string, string>(ledgerIds.map((id) => [id, '0.0000']));
  if (ledgerIds.length === 0) return out;
  const rows = await tx.$queryRawUnsafe<{ id: string; bal: string }[]>(
    `SELECT "accountId"::text AS id, SUM(debit - credit)::numeric(19,4)::text AS bal FROM journal_lines WHERE "companyId" = $1::uuid AND "accountId" = ANY($2::uuid[]) GROUP BY 1`,
    companyId,
    ledgerIds,
  );
  for (const r of rows) out.set(r.id, r.bal);
  return out;
}

const present = (a: Row & { ledgerAccount: { code: string } }, balance: string) => ({
  id: a.id,
  name: a.name,
  type: a.type,
  location: a.location,
  status: a.status,
  ledgerCode: a.ledgerAccount.code,
  balance,
});

/** Which accounts this person may see: 'all', or only the drawers at these places. */
function visibility(auth: AuthContext): 'all' | string[] | null {
  if (scopeFor(auth, 'accounting.view') === 'company' || scopeFor(auth, 'cash.manage') === 'company') return 'all';
  return scopeFor(auth, 'cash.manage') ? auth.locationIds : null;
}
const mayManage = (auth: AuthContext, a: { type: string; locationId: string | null }) =>
  a.type === 'CASH' ? can(auth, 'cash.manage', { locationId: a.locationId ?? undefined }) && a.locationId !== null : scopeFor(auth, 'cash.manage') === 'company';

export async function listMoneyAccounts(auth: AuthContext, status: 'ACTIVE' | 'INACTIVE' | 'ALL') {
  const vis = visibility(auth);
  if (!vis) throw forbidden();
  return withTenant(auth, async (tx) => {
    const rows = await tx.financialAccount.findMany({
      where: {
        companyId: auth.companyId,
        ...(status === 'ALL' ? {} : { status }),
        ...(vis === 'all' ? {} : { type: 'CASH', locationId: { in: vis } }),
      },
      include,
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    const bal = await balances(tx, auth.companyId, rows.map((r) => r.ledgerAccountId));
    return { accounts: rows.map((r) => present(r, bal.get(r.ledgerAccountId)!)) };
  });
}

async function detail(tx: Tx, auth: AuthContext, id: string) {
  const vis = visibility(auth);
  const a = await tx.financialAccount.findFirst({ where: { id, companyId: auth.companyId }, include });
  if (!vis || !a || (vis !== 'all' && !(a.type === 'CASH' && a.locationId && vis.includes(a.locationId)))) throw notFound('Account not found');
  const bal = await balances(tx, auth.companyId, [a.ledgerAccountId]);
  return { account: present(a, bal.get(a.ledgerAccountId)!) };
}

export const getMoneyAccount = (auth: AuthContext, id: string) => withTenant(auth, (tx) => detail(tx, auth, id));

/** The next free accounting code under the cash or bank root (cash 1011-1099, bank 1101-1199). */
async function nextCode(tx: Tx, companyId: string, rootKey: 'CASH_ROOT' | 'BANK_ROOT') {
  const root = await tx.account.findFirst({ where: { companyId, systemKey: rootKey }, select: { id: true, code: true } });
  if (!root) throw conflict('The chart of accounts is missing its cash or bank group');
  const kids = await tx.account.findMany({ where: { companyId, parentId: root.id }, select: { code: true } });
  const next = Math.max(Number(root.code), ...kids.map((k) => Number(k.code))) + 1;
  if (next > Number(root.code) + 89 + (rootKey === 'CASH_ROOT' ? 0 : 10)) throw conflict('Too many accounts of this kind');
  return { rootId: root.id, code: String(next) };
}

export async function createMoneyAccount(auth: AuthContext, input: CreateMoneyAccountInput, ip?: string) {
  const isCash = input.type === 'CASH';
  if (isCash ? !can(auth, 'cash.manage', { locationId: input.locationId }) : scopeFor(auth, 'cash.manage') !== 'company') {
    throw forbidden(isCash ? 'You can only add cash drawers for your own places' : 'Only the Admin can add bank accounts');
  }
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    if (isCash) {
      const loc = await tx.location.findFirst({ where: { id: input.locationId!, companyId }, select: { status: true, name: true } });
      if (!loc) throw notFound('Location not found');
      if (loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off`);
    }
    const dup = await tx.financialAccount.findFirst({ where: { companyId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
    if (dup) throw conflict(`An account called "${input.name}" already exists`);
    const { rootId, code } = await nextCode(tx, companyId, isCash ? 'CASH_ROOT' : 'BANK_ROOT');
    const ledger = await tx.account.create({ data: { companyId, code, name: input.name, type: 'ASSET', parentId: rootId, isPostable: true }, select: { id: true } });
    const created = await tx.financialAccount.create({
      data: { companyId, name: input.name, type: input.type, locationId: isCash ? input.locationId! : null, ledgerAccountId: ledger.id },
      select: { id: true },
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'money_account.created', entityType: 'financial_account', entityId: created.id, after: { name: input.name, type: input.type, code }, ip });
    return detail(tx, auth, created.id);
  });
}

export async function updateMoneyAccount(auth: AuthContext, id: string, input: UpdateMoneyAccountInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const a = await tx.financialAccount.findFirst({ where: { id, companyId } });
    const vis = visibility(auth);
    if (!a || !vis || (vis !== 'all' && !(a.type === 'CASH' && a.locationId && vis.includes(a.locationId)))) throw notFound('Account not found');
    if (!mayManage(auth, a)) throw forbidden('You cannot change this account');
    const data: { name?: string; status?: 'ACTIVE' | 'INACTIVE' } = {};
    if (input.name !== undefined && input.name !== a.name) {
      const dup = await tx.financialAccount.findFirst({ where: { companyId, name: { equals: input.name, mode: 'insensitive' }, id: { not: id } }, select: { id: true } });
      if (dup) throw conflict(`An account called "${input.name}" already exists`);
      data.name = input.name;
    }
    if (input.status !== undefined && input.status !== a.status) {
      if (input.status === 'INACTIVE') {
        const bal = (await balances(tx, companyId, [a.ledgerAccountId])).get(a.ledgerAccountId)!;
        if (!D(bal).isZero()) throw conflict(`This account still holds ${D(bal).toFixed(2)} USD. Move the money out before switching it off.`);
      }
      data.status = input.status;
    }
    if (Object.keys(data).length > 0) {
      await tx.financialAccount.update({ where: { id }, data });
      if (data.name) await tx.account.update({ where: { id: a.ledgerAccountId }, data: { name: data.name } });
      await writeAudit(tx, { companyId, userId: auth.userId, action: 'money_account.updated', entityType: 'financial_account', entityId: id, before: { name: a.name, status: a.status }, after: data, ip });
    }
    return detail(tx, auth, id);
  });
}