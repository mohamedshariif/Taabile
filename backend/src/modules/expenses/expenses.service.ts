import type { Prisma } from '@prisma/client';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { lockMoneyAccount, moneyAccountBalance } from '../../shared/cashAccounts.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { toDateOnly } from '../../shared/schemas.js';
import { can, scopeFor } from '../auth/permissions.js';
import type { CreateExpenseInput, ExpenseListQuery } from './expenses.schemas.js';

// Expenses, in plain words:
//  * Money paid out for the business (rent, fuel, repairs...), taken from a cash drawer or bank account, booked at once.
//  * A Manager records costs for their own places, from their own drawer. Bank accounts and company-wide costs are the Admin's.
//  * An account can never be spent below zero.
//  * Expenses are never edited. A mistake is cancelled (voided) with a reason, which puts the money back in the books.

const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const m = (v: { toString(): string }) => D(v.toString()).toFixed(4);

const include = {
  category: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  financialAccount: { select: { id: true, name: true, type: true } },
} satisfies Prisma.ExpenseInclude;
type Row = Prisma.ExpenseGetPayload<{ include: typeof include }>;

const present = (e: Row) => ({
  id: e.id,
  number: e.number,
  category: e.category,
  location: e.location,
  account: e.financialAccount,
  amount: m(e.amount),
  incurredOn: e.incurredAt.toISOString().slice(0, 10),
  description: e.description,
  status: e.status,
  createdById: e.createdById,
  approvedById: e.approvedById,
});

/** Which expenses this person may see: everything, their places' (and their own), or nothing. */
function visibility(auth: AuthContext): Prisma.ExpenseWhereInput {
  const scope = scopeFor(auth, 'expenses.create');
  if (!scope) throw forbidden();
  if (scope === 'company') return {};
  return { OR: [{ locationId: { in: auth.locationIds } }, { createdById: auth.userId }] };
}

export async function listCategories(auth: AuthContext) {
  if (!scopeFor(auth, 'expenses.create')) throw forbidden();
  return withTenant(auth, async (tx) => ({
    categories: await tx.expenseCategory.findMany({ where: { companyId: auth.companyId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  }));
}

export async function listExpenses(auth: AuthContext, f: ExpenseListQuery) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const and: Prisma.ExpenseWhereInput[] = [vis];
    if (f.from || f.to) and.push({ incurredAt: { ...(f.from ? { gte: toDateOnly(f.from) } : {}), ...(f.to ? { lte: toDateOnly(f.to) } : {}) } });
    const where: Prisma.ExpenseWhereInput = {
      companyId: auth.companyId,
      AND: and,
      ...(f.status ? { status: f.status } : {}),
      ...(f.locationId ? { locationId: f.locationId } : {}),
      ...(f.categoryId ? { categoryId: f.categoryId } : {}),
      ...(f.search ? { OR: [{ description: { contains: f.search, mode: 'insensitive' } }, { number: { contains: f.search, mode: 'insensitive' } }] } : {}),
    };
    const rows = await tx.expense.findMany({ where, include, orderBy: [{ incurredAt: 'desc' }, { id: 'desc' }], ...pageArgs(f) });
    // The total of the valid expenses matching the filter (cancelled ones never count).
    const agg = await tx.expense.aggregate({ where: { ...where, status: 'POSTED' }, _sum: { amount: true } });
    const page = toPage(rows, f.limit);
    return { items: page.items.map(present), nextCursor: page.nextCursor, total: m(agg._sum.amount ?? 0) };
  });
}

export async function getExpense(auth: AuthContext, id: string) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const e = await tx.expense.findFirst({ where: { id, companyId: auth.companyId, ...vis }, include });
    if (!e) throw notFound('Expense not found');
    return { expense: present(e) };
  });
}

async function load(tx: Tx, companyId: string, id: string) {
  return { expense: present(await tx.expense.findFirstOrThrow({ where: { id, companyId }, include })) };
}

export async function createExpense(auth: AuthContext, input: CreateExpenseInput, ip?: string) {
  const scope = scopeFor(auth, 'expenses.create');
  if (!scope) throw forbidden();
  if (scope !== 'company') {
    if (!input.locationId) throw badRequest('Choose which of your places this cost belongs to');
    if (!auth.locationIds.includes(input.locationId)) throw forbidden('You can only record costs for your own places');
  }
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const category = await tx.expenseCategory.findFirst({ where: { id: input.categoryId, companyId } });
    if (!category) throw notFound('Category not found');
    if (category.status !== 'ACTIVE') throw badRequest(`"${category.name}" is switched off`);
    if (input.locationId) {
      const loc = await tx.location.findFirst({ where: { id: input.locationId, companyId }, select: { name: true, status: true } });
      if (!loc) throw notFound('Location not found');
      if (loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off`);
    }
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, companyId } });
    if (!account) throw notFound('Cash or bank account not found');
    if (account.status !== 'ACTIVE') throw badRequest(`"${account.name}" is switched off`);
    if (scope !== 'company') {
      if (account.type === 'BANK') throw forbidden('Only the Admin can pay costs from a bank account');
      if (!(account.locationId && auth.locationIds.includes(account.locationId))) throw forbidden('That cash drawer belongs to another place');
    }
    const day = input.incurredOn ? toDateOnly(input.incurredOn) : today();
    if (day.getTime() > today().getTime()) throw badRequest('The date cannot be in the future');

    const amount = D(input.amount);
    await lockMoneyAccount(tx, account.id);
    const bal = await moneyAccountBalance(tx, companyId, account.ledgerAccountId);
    if (amount.gt(bal)) throw conflict(`"${account.name}" only holds ${bal.toFixed(2)}, so ${amount.toFixed(2)} cannot be paid from it`);

    const number = await nextDocumentNumber(tx, companyId, 'EXP', { prefix: 'EX' });
    const mayApprove = !!scopeFor(auth, 'expenses.approve');
    const e = await tx.expense.create({
      data: {
        companyId, number, locationId: input.locationId ?? null, categoryId: category.id, amount: amount.toString(), incurredAt: day,
        description: input.description, payStatus: 'PAID', financialAccountId: account.id, status: 'POSTED', createdById: auth.userId,
        ...(mayApprove ? { approvedById: auth.userId, approvedAt: new Date() } : {}),
      },
      select: { id: true },
    });
    await postJournal(tx, {
      companyId, userId: auth.userId,
      draft: posting.expense({ expenseAccountId: category.ledgerAccountId, amount, locationId: input.locationId ?? null, paidBy: { financialAccountId: account.ledgerAccountId } }),
      entryDate: day, sourceId: e.id, event: 'expense',
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'expense.created', entityType: 'expense', entityId: e.id, after: { number, category: category.name, amount: amount.toFixed(2), account: account.name }, ip });
    return load(tx, companyId, e.id);
  });
}

export async function voidExpense(auth: AuthContext, id: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM expenses WHERE id = ${id}::uuid FOR UPDATE`;
    const e = await tx.expense.findFirst({ where: { id, companyId } });
    if (!e) throw notFound('Expense not found');
    if (!can(auth, 'expenses.approve', { locationId: e.locationId ?? undefined }) || (e.locationId === null && scopeFor(auth, 'expenses.approve') !== 'company')) {
      throw forbidden('Only a Manager of that place or the Admin can cancel an expense');
    }
    if (e.status !== 'POSTED') throw conflict('This expense is already cancelled');
    const entries = await tx.journalEntry.findMany({ where: { companyId, sourceId: id, reversalOfId: null, reversedBy: { is: null } }, select: { id: true } });
    for (const x of entries) await reverseJournal(tx, { companyId, userId: auth.userId }, x.id, { date: today(), reason: `Cancelled expense ${e.number}: ${reason}` });
    await tx.expense.update({ where: { id }, data: { status: 'VOIDED', description: `${e.description} · Cancelled: ${reason}` } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'expense.voided', entityType: 'expense', entityId: id, after: { number: e.number, reason }, ip });
    return load(tx, companyId, id);
  });
}