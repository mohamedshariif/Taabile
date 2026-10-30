import { randomUUID } from 'node:crypto';
import type { FinancialAccount, Prisma } from '@prisma/client';
import { postJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { lockMoneyAccount, moneyAccountBalance } from '../../shared/cashAccounts.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { scopeFor } from '../auth/permissions.js';
import type { ConfirmTransferInput, CountInput, CreateTransferInput, TransferListQuery } from './cash.schemas.js';

// Moving and counting money, in plain words:
//  * A transfer moves money between two accounts. Cash that leaves a drawer for a bank or another drawer is "in transit"
//    until the other side confirms what really arrived. If the amount differs, the difference is booked as a cash
//    shortage or overage (never as income or expense by accident).
//  * Money moving out of a bank account straight into a drawer, or between banks, needs no confirmation: it is the Admin's.
//  * A count compares what is really in a drawer with what the books say it should hold, and books any difference.
//  * Nothing is edited. Accounts can never be overdrawn.

const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const m = (v: { toString(): string }) => D(v.toString()).toFixed(4);

/** May this person act on this account? A drawer: at their own place (or company-wide). A bank account: company-wide only. */
function mayActOn(auth: AuthContext, a: Pick<FinancialAccount, 'type' | 'locationId'>): boolean {
  const scope = scopeFor(auth, 'cash.manage');
  if (!scope) return false;
  if (scope === 'company') return true;
  return a.type === 'CASH' && !!a.locationId && auth.locationIds.includes(a.locationId);
}

async function usable(tx: Tx, companyId: string, id: string) {
  const a = await tx.financialAccount.findFirst({ where: { id, companyId } });
  if (!a) throw notFound('Cash or bank account not found');
  if (a.status !== 'ACTIVE') throw badRequest(`"${a.name}" is switched off`);
  return a;
}

const include = {
  fromAccount: { select: { id: true, name: true, type: true, locationId: true } },
  toAccount: { select: { id: true, name: true, type: true, locationId: true } },
} satisfies Prisma.FundsTransferInclude;
type Row = Prisma.FundsTransferGetPayload<{ include: typeof include }>;

const present = (t: Row) => ({
  id: t.id,
  number: t.number,
  type: t.type,
  from: { id: t.fromAccount.id, name: t.fromAccount.name, type: t.fromAccount.type },
  to: { id: t.toAccount.id, name: t.toAccount.name, type: t.toAccount.type },
  amount: m(t.amount),
  received: t.countedAmount === null ? null : m(t.countedAmount),
  difference: m(t.differenceAmount),
  differenceNote: t.differenceNote,
  status: t.status,
  occurredAt: t.occurredAt.toISOString(),
  confirmedAt: t.confirmedAt?.toISOString() ?? null,
  createdById: t.createdById,
  confirmedById: t.confirmedById,
});

/**
 * The accounts to choose from on the money screens (no balances): `from` = where this person may take money out,
 * `to` = every active account in the company (money may be sent to another place's drawer or to a bank).
 */
export async function chooseAccounts(auth: AuthContext) {
  if (!scopeFor(auth, 'cash.manage')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const rows = await tx.financialAccount.findMany({
      where: { companyId: auth.companyId, status: 'ACTIVE' },
      select: { id: true, name: true, type: true, locationId: true, location: { select: { name: true } } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    const slim = (a: (typeof rows)[number]) => ({ id: a.id, name: a.name, type: a.type, place: a.location?.name ?? null });
    return { from: rows.filter((a) => mayActOn(auth, a)).map(slim), to: rows.map(slim) };
  });
}

/** Transfers that involve a drawer at this person's places (company-wide people see all). */
function visibility(auth: AuthContext): Prisma.FundsTransferWhereInput {
  const scope = scopeFor(auth, 'cash.manage');
  if (!scope) throw forbidden();
  if (scope === 'company') return {};
  return { OR: [{ fromAccount: { locationId: { in: auth.locationIds } } }, { toAccount: { locationId: { in: auth.locationIds } } }] };
}

export async function listTransfers(auth: AuthContext, f: TransferListQuery) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const rows = await tx.fundsTransfer.findMany({
      where: {
        companyId: auth.companyId,
        AND: [vis],
        ...(f.status ? { status: f.status } : {}),
        ...(f.accountId ? { OR: [{ fromAccountId: f.accountId }, { toAccountId: f.accountId }] } : {}),
      },
      include,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(f),
    });
    const page = toPage(rows, f.limit);
    return { items: page.items.map(present), nextCursor: page.nextCursor };
  });
}

export async function getTransfer(auth: AuthContext, id: string) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const t = await tx.fundsTransfer.findFirst({ where: { id, companyId: auth.companyId, AND: [vis] }, include });
    if (!t) throw notFound('Transfer not found');
    return { transfer: present(t) };
  });
}

async function loadTransfer(tx: Tx, companyId: string, id: string) {
  return { transfer: present(await tx.fundsTransfer.findFirstOrThrow({ where: { id, companyId }, include })) };
}

export async function createTransfer(auth: AuthContext, input: CreateTransferInput, ip?: string) {
  if (!scopeFor(auth, 'cash.manage')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const from = await usable(tx, companyId, input.fromAccountId);
    const to = await usable(tx, companyId, input.toAccountId);
    if (!mayActOn(auth, from)) throw forbidden(from.type === 'BANK' ? 'Only the Admin can move money out of a bank account' : 'That cash drawer belongs to another place');

    // Cash leaving a drawer is "in transit" until the other side confirms. Bank to anywhere is direct.
    const viaTransit = from.type === 'CASH';
    const type = from.type === 'CASH' ? (to.type === 'BANK' ? 'DEPOSIT' : 'HANDOVER') : to.type === 'CASH' ? 'WITHDRAWAL' : 'TRANSFER';
    const amount = D(input.amount);

    await lockMoneyAccount(tx, from.id);
    const bal = await moneyAccountBalance(tx, companyId, from.ledgerAccountId);
    if (amount.gt(bal)) throw conflict(`"${from.name}" only holds ${bal.toFixed(2)}, so ${amount.toFixed(2)} cannot be moved out of it`);

    const number = await nextDocumentNumber(tx, companyId, 'TRF', { prefix: 'TR' });
    const now = new Date();
    const t = await tx.fundsTransfer.create({
      data: {
        companyId, number, type, fromAccountId: from.id, toAccountId: to.id, amount: amount.toString(), occurredAt: now, createdById: auth.userId,
        ...(viaTransit ? { status: 'PENDING' as const } : { status: 'CONFIRMED' as const, confirmedById: auth.userId, confirmedAt: now, countedAmount: amount.toString(), expectedAmount: amount.toString() }),
      },
      select: { id: true },
    });
    await postJournal(tx, {
      companyId, userId: auth.userId,
      draft: posting.fundsTransferSent({ fromAccountId: from.ledgerAccountId, amount, viaTransit, ...(viaTransit ? {} : { toAccountId: to.ledgerAccountId }) }),
      entryDate: today(), sourceId: t.id, event: 'sent',
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'cash.transfer_sent', entityType: 'funds_transfer', entityId: t.id, after: { number, type, from: from.name, to: to.name, amount: amount.toFixed(2), ...(input.note ? { note: input.note } : {}) }, ip });
    return loadTransfer(tx, companyId, t.id);
  });
}

export async function confirmTransfer(auth: AuthContext, id: string, input: ConfirmTransferInput, ip?: string) {
  if (!scopeFor(auth, 'cash.manage')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM funds_transfers WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.fundsTransfer.findFirst({ where: { id, companyId }, include });
    if (!t) throw notFound('Transfer not found');
    if (t.status !== 'PENDING') throw conflict('This transfer is already confirmed');
    const to = await tx.financialAccount.findUniqueOrThrow({ where: { id: t.toAccountId } });
    if (!mayActOn(auth, to)) throw forbidden(to.type === 'BANK' ? 'Only the Admin can confirm money arriving in a bank account' : 'Only someone at the receiving place can confirm');
    // The person who sent the money cannot also confirm it, unless they work company-wide.
    if (t.createdById === auth.userId && scopeFor(auth, 'cash.manage') !== 'company') throw forbidden('Someone else must confirm this: the person who sent it cannot');

    const amount = D(t.amount.toString());
    const received = input.receivedAmount !== undefined ? D(input.receivedAmount) : amount;
    const shortage = amount.minus(received); // positive = less arrived than was sent
    if (!shortage.isZero() && !input.differenceNote) throw badRequest('The amount received differs from the amount sent. Write a short note saying why.');

    await postJournal(tx, { companyId, userId: auth.userId, draft: posting.fundsTransferConfirmed({ toAccountId: to.ledgerAccountId, amount }), entryDate: today(), sourceId: id, event: 'confirmed' });
    if (!shortage.isZero()) {
      await postJournal(tx, { companyId, userId: auth.userId, draft: posting.cashDifference({ financialAccountId: to.ledgerAccountId, shortage }), entryDate: today(), sourceId: id, event: 'difference' });
    }
    await tx.fundsTransfer.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedById: auth.userId, confirmedAt: new Date(), expectedAmount: amount.toString(), countedAmount: received.toString(), differenceAmount: shortage.toString(), differenceNote: input.differenceNote ?? null },
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'cash.transfer_confirmed', entityType: 'funds_transfer', entityId: id, after: { number: t.number, sent: amount.toFixed(2), received: received.toFixed(2) }, ip });
    return loadTransfer(tx, companyId, id);
  });
}

/**
 * A cash count: what is really in the drawer against what the books say. Any difference is booked as a cash shortage or
 * overage and needs a note. The expected amount is not shown before counting, so the count is honest.
 */
export async function countAccount(auth: AuthContext, input: CountInput, ip?: string) {
  if (!scopeFor(auth, 'cash.manage')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const a = await usable(tx, companyId, input.financialAccountId);
    if (!mayActOn(auth, a)) throw forbidden(a.type === 'BANK' ? 'Only the Admin can reconcile a bank account' : 'That cash drawer belongs to another place');
    await lockMoneyAccount(tx, a.id);
    const expected = await moneyAccountBalance(tx, companyId, a.ledgerAccountId);
    const counted = D(input.counted);
    const shortage = expected.minus(counted);
    if (!shortage.isZero() && !input.note) throw badRequest(`The count differs from the books by ${shortage.abs().toFixed(2)}. Write a short note saying why.`);

    const countId = randomUUID();
    let entry: string | null = null;
    if (!shortage.isZero()) {
      const r = await postJournal(tx, { companyId, userId: auth.userId, draft: posting.cashDifference({ financialAccountId: a.ledgerAccountId, shortage }), entryDate: today(), sourceId: countId, event: 'difference' });
      entry = r.number;
    }
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'cash.counted', entityType: 'financial_account', entityId: a.id, after: { account: a.name, expected: expected.toFixed(2), counted: counted.toFixed(2), difference: shortage.toFixed(2), ...(input.note ? { note: input.note } : {}) }, ip });
    return {
      count: {
        account: { id: a.id, name: a.name },
        expected: expected.toFixed(4),
        counted: counted.toFixed(4),
        /** Positive = money is missing, negative = there is more than the books say. */
        difference: shortage.toFixed(4),
        result: shortage.isZero() ? ('MATCH' as const) : shortage.gt(0) ? ('SHORTAGE' as const) : ('OVERAGE' as const),
        journalEntry: entry,
      },
    };
  });
}