import type { Prisma } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { customerBalances, supplierBalances } from '../../shared/balances.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D, ZERO } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { toDateOnly } from '../../shared/schemas.js';
import { scopeFor, type Permission } from '../auth/permissions.js';
import type { PaymentListQuery, PaySupplierInput, ReceiveInput, StatementQuery } from './payments.schemas.js';

// Payments, in plain words:
//  * Money received from a customer (or paid to a supplier) goes into / out of a cash drawer or bank account.
//  * It is matched to specific invoices (sales) or bills (purchase receipts). Leave the matching out and the oldest
//    documents are paid first. A payment can never be more than what is owed: there are no advances yet.
//  * The accounting entry is made at once. Payments are never edited; a mistake is cancelled (voided) by an Admin,
//    which reverses the entry and re-opens the documents it had paid.
//  * What someone owes is always read from the ledger, so statements, balances and the books cannot disagree.

const todayUtc = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const m = (v: { toString(): string }) => D(v.toString()).toFixed(4);
const sum = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), ZERO);

/** The money account must exist, be on, and (for a cash drawer) be at a place this person works at, unless they work company-wide. */
async function usableAccount(tx: Tx, auth: AuthContext, perm: Permission, id: string) {
  const scope = scopeFor(auth, perm);
  if (!scope) throw forbidden();
  const a = await tx.financialAccount.findFirst({ where: { id, companyId: auth.companyId } });
  if (!a) throw notFound('Cash or bank account not found');
  if (a.status !== 'ACTIVE') throw badRequest(`"${a.name}" is switched off`);
  if (a.type === 'CASH' && scope !== 'company' && !(a.locationId && auth.locationIds.includes(a.locationId))) throw forbidden('That cash drawer belongs to another place');
  return a;
}

interface Open { id: string; owed: Decimal }

/**
 * Decide which documents a payment settles. `given` = the person's choice; otherwise oldest first.
 * The total must equal the payment, and no document may be paid more than it is owed.
 */
function allocate(amount: Decimal, open: Open[], given: { id: string; amount: string }[] | undefined, what: string): { id: string; amount: Decimal }[] {
  const owedAll = sum(open.map((o) => o.owed));
  if (!given) {
    if (amount.gt(owedAll)) throw badRequest(`The payment (${amount.toFixed(2)}) is more than the ${what} (${owedAll.toFixed(2)}). Advance payments are not supported yet.`);
    const out: { id: string; amount: Decimal }[] = [];
    let left = amount;
    for (const o of open) {
      if (left.lte(0)) break;
      const take = left.lt(o.owed) ? left : o.owed;
      out.push({ id: o.id, amount: take });
      left = left.minus(take);
    }
    return out;
  }
  const byId = new Map(open.map((o) => [o.id, o]));
  const out = given.map((g) => {
    const o = byId.get(g.id);
    if (!o) throw badRequest('One of the documents is not open (wrong party, already paid, or cancelled)');
    const a = D(g.amount);
    if (a.gt(o.owed)) throw badRequest(`A document is only owed ${o.owed.toFixed(2)}, but ${a.toFixed(2)} was applied to it`);
    return { id: g.id, amount: a };
  });
  if (!sum(out.map((x) => x.amount)).equals(amount)) throw badRequest('The amounts applied to the documents must add up to the payment');
  return out;
}

const saleStatus = (total: Decimal, paid: Decimal) => (paid.gte(total) ? 'PAID' : paid.gt(0) ? 'PARTIAL' : 'UNPAID') as 'PAID' | 'PARTIAL' | 'UNPAID';

// ───────────────────────── receiving money from a customer ─────────────────────────

export async function receivePayment(auth: AuthContext, input: ReceiveInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, companyId }, select: { id: true, name: true } });
    if (!customer) throw notFound('Customer not found');
    const account = await usableAccount(tx, auth, 'payments.receive', input.financialAccountId);
    const amount = D(input.amount);

    // One customer's payments and credit sales go through one at a time; the invoices are locked in a fixed order.
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customer.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM sales WHERE "companyId" = ${companyId}::uuid AND "customerId" = ${customer.id}::uuid AND status = 'POSTED' ORDER BY id FOR UPDATE`;
    const sales = await tx.sale.findMany({ where: { companyId, customerId: customer.id, status: 'POSTED' }, orderBy: [{ soldAt: 'asc' }, { id: 'asc' }], select: { id: true, number: true, total: true, paidTotal: true } });
    const open = sales.map((s) => ({ id: s.id, owed: D(s.total.toString()).minus(D(s.paidTotal.toString())) })).filter((o) => o.owed.gt(0));
    const parts = allocate(amount, open, input.allocations?.map((a) => ({ id: a.saleId, amount: a.amount })), 'customer owes on open invoices');

    const number = await nextDocumentNumber(tx, companyId, 'PAY', { prefix: 'PM' });
    const payment = await tx.payment.create({
      data: {
        companyId, number, partyType: 'CUSTOMER', customerId: customer.id, financialAccountId: account.id,
        method: account.type === 'CASH' ? 'CASH' : 'BANK_TRANSFER', amount: amount.toString(), paidAt: new Date(), status: 'POSTED',
        reference: input.reference ?? null, note: input.note ?? null, createdById: auth.userId,
      },
      select: { id: true },
    });
    for (const p of parts) {
      const s = sales.find((x) => x.id === p.id)!;
      const paid = D(s.paidTotal.toString()).plus(p.amount);
      await tx.paymentAllocation.create({ data: { companyId, paymentId: payment.id, saleId: p.id, amount: p.amount.toString(), createdById: auth.userId } });
      await tx.sale.update({ where: { id: p.id }, data: { paidTotal: paid.toString(), paymentStatus: saleStatus(D(s.total.toString()), paid) } });
    }
    await postJournal(tx, { companyId, userId: auth.userId, draft: posting.customerPayment({ customerId: customer.id, financialAccountId: account.ledgerAccountId, amount }), entryDate: todayUtc(), sourceId: payment.id, event: 'payment' });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payment.received', entityType: 'payment', entityId: payment.id, after: { number, customer: customer.name, amount: amount.toFixed(2) }, ip });
    return loadPayment(tx, companyId, payment.id);
  });
}

// ───────────────────────── paying a supplier ─────────────────────────

export async function paySupplier(auth: AuthContext, input: PaySupplierInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, companyId }, select: { id: true, name: true } });
    if (!supplier) throw notFound('Supplier not found');
    const account = await usableAccount(tx, auth, 'payments.pay_supplier', input.financialAccountId);
    const amount = D(input.amount);
    // Never pay out more than the account holds.
    const bal = await accountBalance(tx, companyId, account.ledgerAccountId);
    if (amount.gt(bal)) throw conflict(`"${account.name}" only holds ${bal.toFixed(2)}, so ${amount.toFixed(2)} cannot be paid from it`);

    await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${supplier.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM purchase_receipts WHERE "companyId" = ${companyId}::uuid AND "supplierId" = ${supplier.id}::uuid AND status = 'POSTED' ORDER BY id FOR UPDATE`;
    const bills = await tx.purchaseReceipt.findMany({ where: { companyId, supplierId: supplier.id, status: 'POSTED' }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { id: true, number: true, total: true, paidTotal: true } });
    const open = bills.map((b) => ({ id: b.id, owed: D(b.total.toString()).minus(D(b.paidTotal.toString())) })).filter((o) => o.owed.gt(0));
    const parts = allocate(amount, open, input.allocations?.map((a) => ({ id: a.receiptId, amount: a.amount })), 'we owe on open bills');

    const number = await nextDocumentNumber(tx, companyId, 'PAY', { prefix: 'PM' });
    const payment = await tx.payment.create({
      data: {
        companyId, number, partyType: 'SUPPLIER', supplierId: supplier.id, financialAccountId: account.id,
        method: account.type === 'CASH' ? 'CASH' : 'BANK_TRANSFER', amount: amount.toString(), paidAt: new Date(), status: 'POSTED',
        reference: input.reference ?? null, note: input.note ?? null, createdById: auth.userId,
      },
      select: { id: true },
    });
    for (const p of parts) {
      const b = bills.find((x) => x.id === p.id)!;
      await tx.paymentAllocation.create({ data: { companyId, paymentId: payment.id, purchaseReceiptId: p.id, amount: p.amount.toString(), createdById: auth.userId } });
      await tx.purchaseReceipt.update({ where: { id: p.id }, data: { paidTotal: D(b.paidTotal.toString()).plus(p.amount).toString() } });
    }
    await postJournal(tx, { companyId, userId: auth.userId, draft: posting.supplierPayment({ supplierId: supplier.id, financialAccountId: account.ledgerAccountId, amount }), entryDate: todayUtc(), sourceId: payment.id, event: 'payment' });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payment.supplier_paid', entityType: 'payment', entityId: payment.id, after: { number, supplier: supplier.name, amount: amount.toFixed(2) }, ip });
    return loadPayment(tx, companyId, payment.id);
  });
}

async function accountBalance(tx: Tx, companyId: string, ledgerAccountId: string): Promise<Decimal> {
  const r = await tx.$queryRaw<{ b: string | null }[]>`SELECT SUM(debit - credit)::numeric(19,4)::text AS b FROM journal_lines WHERE "companyId" = ${companyId}::uuid AND "accountId" = ${ledgerAccountId}::uuid`;
  return D(r[0]?.b ?? '0');
}

// ───────────────────────── cancelling a payment ─────────────────────────

/**
 * Cancels a payment: the money movement is reversed in the books and the invoices or bills it had paid are open again.
 * The payment stays on record as VOIDED. A payment taken at the till for a walk-in sale is cancelled by voiding the sale.
 */
export async function voidPayment(auth: AuthContext, paymentId: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const first = await tx.payment.findFirst({ where: { id: paymentId, companyId }, include: { paymentAllocations: true } });
    if (!first) throw notFound('Payment not found');
    // Lock the documents first, then the payment (the same order a sale void uses), so the two can never wait on each other.
    const saleIds = first.paymentAllocations.flatMap((a) => (a.saleId ? [a.saleId] : [])).sort();
    const billIds = first.paymentAllocations.flatMap((a) => (a.purchaseReceiptId ? [a.purchaseReceiptId] : [])).sort();
    if (saleIds.length > 0) await tx.$queryRaw`SELECT id FROM sales WHERE id = ANY(${saleIds}::uuid[]) ORDER BY id FOR UPDATE`;
    if (billIds.length > 0) await tx.$queryRaw`SELECT id FROM purchase_receipts WHERE id = ANY(${billIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const p = await tx.payment.findFirstOrThrow({ where: { id: paymentId, companyId }, include: { paymentAllocations: true } });
    if (p.status !== 'POSTED') throw conflict('This payment is already cancelled');
    if (p.partyType === 'CUSTOMER' && !p.customerId) throw conflict('This payment was taken for a walk-in sale. Void the sale instead.');

    for (const a of p.paymentAllocations) {
      if (a.saleId) {
        const s = await tx.sale.findUniqueOrThrow({ where: { id: a.saleId }, select: { total: true, paidTotal: true } });
        const paid = D(s.paidTotal.toString()).minus(D(a.amount.toString()));
        await tx.sale.update({ where: { id: a.saleId }, data: { paidTotal: paid.toString(), paymentStatus: saleStatus(D(s.total.toString()), paid) } });
      } else if (a.purchaseReceiptId) {
        await tx.purchaseReceipt.update({ where: { id: a.purchaseReceiptId }, data: { paidTotal: { decrement: a.amount.toString() } } });
      }
    }
    const entries = await tx.journalEntry.findMany({ where: { companyId, sourceId: paymentId, reversalOfId: null, reversedBy: { is: null } }, select: { id: true } });
    for (const e of entries) await reverseJournal(tx, { companyId, userId: auth.userId }, e.id, { date: todayUtc(), reason: `Cancelled payment ${p.number}: ${reason}` });
    await tx.payment.update({ where: { id: paymentId }, data: { status: 'VOIDED', note: [p.note, `Cancelled: ${reason}`].filter(Boolean).join(' · ') } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payment.voided', entityType: 'payment', entityId: paymentId, after: { number: p.number, reason }, ip });
    return loadPayment(tx, companyId, paymentId);
  });
}

// ───────────────────────── reading ─────────────────────────

const detailInclude = {
  customer: { select: { id: true, code: true, name: true } },
  supplier: { select: { id: true, code: true, name: true } },
  financialAccount: { select: { id: true, name: true, type: true, locationId: true } },
  paymentAllocations: { orderBy: { createdAt: 'asc' as const }, include: { sale: { select: { id: true, number: true } }, purchaseReceipt: { select: { id: true, number: true } } } },
} satisfies Prisma.PaymentInclude;
type Detail = Prisma.PaymentGetPayload<{ include: typeof detailInclude }>;

function present(p: Detail) {
  return {
    id: p.id,
    number: p.number,
    partyType: p.partyType,
    customer: p.customer,
    supplier: p.supplier,
    account: { id: p.financialAccount.id, name: p.financialAccount.name, type: p.financialAccount.type },
    method: p.method,
    amount: m(p.amount),
    paidAt: p.paidAt.toISOString(),
    reference: p.reference,
    status: p.status,
    note: p.note,
    createdById: p.createdById,
    allocations: p.paymentAllocations.map((a) => ({ id: a.id, amount: m(a.amount), document: a.sale ? { kind: 'SALE' as const, id: a.sale.id, number: a.sale.number } : { kind: 'RECEIPT' as const, id: a.purchaseReceipt!.id, number: a.purchaseReceipt!.number } })),
  };
}

async function loadPayment(tx: Tx, companyId: string, id: string) {
  return { payment: present(await tx.payment.findFirstOrThrow({ where: { id, companyId }, include: detailInclude })) };
}

/** Payments taken or made at this person's places (or by them). Company-wide viewers see everything. */
function visibility(auth: AuthContext): Prisma.PaymentWhereInput {
  const scope = scopeFor(auth, 'payments.view');
  if (!scope) throw forbidden();
  if (scope === 'company') return {};
  return { OR: [{ financialAccount: { locationId: { in: auth.locationIds } } }, { createdById: auth.userId }] };
}

export async function getPayment(auth: AuthContext, id: string) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id, companyId: auth.companyId, ...vis }, include: detailInclude });
    if (!p) throw notFound('Payment not found');
    return { payment: present(p) };
  });
}

export async function listPayments(auth: AuthContext, f: PaymentListQuery) {
  const vis = visibility(auth);
  return withTenant(auth, async (tx) => {
    const and: Prisma.PaymentWhereInput[] = [vis];
    if (f.from || f.to) and.push({ paidAt: { ...(f.from ? { gte: toDateOnly(f.from) } : {}), ...(f.to ? { lt: new Date(toDateOnly(f.to).getTime() + 86_400_000) } : {}) } });
    const rows = await tx.payment.findMany({
      where: {
        companyId: auth.companyId,
        AND: and,
        ...(f.partyType ? { partyType: f.partyType } : {}),
        ...(f.customerId ? { customerId: f.customerId } : {}),
        ...(f.supplierId ? { supplierId: f.supplierId } : {}),
        ...(f.financialAccountId ? { financialAccountId: f.financialAccountId } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.search ? { OR: [{ number: { contains: f.search, mode: 'insensitive' } }, { reference: { contains: f.search, mode: 'insensitive' } }] } : {}),
      },
      include: detailInclude,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(f),
    });
    const page = toPage(rows, f.limit);
    return { items: page.items.map(present), nextCursor: page.nextCursor };
  });
}

/** The cash drawers and bank accounts this person may use to take or pay money (no balances shown). */
export async function usableAccounts(auth: AuthContext) {
  const scope = scopeFor(auth, 'payments.receive') ?? scopeFor(auth, 'payments.pay_supplier');
  if (!scope) throw forbidden();
  return withTenant(auth, async (tx) => {
    const rows = await tx.financialAccount.findMany({
      where: { companyId: auth.companyId, status: 'ACTIVE', ...(scope === 'company' ? {} : { OR: [{ type: 'BANK' as const }, { type: 'CASH' as const, locationId: { in: auth.locationIds } }] }) },
      select: { id: true, name: true, type: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    return { accounts: rows };
  });
}

/** Invoices (or bills) still owing for one customer (or supplier), oldest first, and the total from the ledger. */
export async function openDocuments(auth: AuthContext, q: { customerId?: string | undefined; supplierId?: string | undefined }) {
  if (!scopeFor(auth, 'payments.view')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const today = todayUtc().getTime();
    if (q.customerId) {
      const c = await tx.customer.findFirst({ where: { id: q.customerId, companyId }, select: { id: true, name: true } });
      if (!c) throw notFound('Customer not found');
      const rows = await tx.sale.findMany({ where: { companyId, customerId: c.id, status: 'POSTED' }, orderBy: [{ soldAt: 'asc' }, { id: 'asc' }], select: { id: true, number: true, soldAt: true, dueDate: true, total: true, paidTotal: true } });
      const items = rows
        .map((s) => ({ kind: 'SALE' as const, id: s.id, number: s.number, date: s.soldAt.toISOString(), dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : null, total: m(s.total), paid: m(s.paidTotal), owed: D(s.total.toString()).minus(D(s.paidTotal.toString())).toFixed(4), overdue: !!s.dueDate && s.dueDate.getTime() < today }))
        .filter((s) => D(s.owed).gt(0));
      return { party: { id: c.id, name: c.name }, balance: (await customerBalances(tx, companyId, [c.id])).get(c.id)!, items };
    }
    const sp = await tx.supplier.findFirst({ where: { id: q.supplierId!, companyId }, select: { id: true, name: true } });
    if (!sp) throw notFound('Supplier not found');
    const rows = await tx.purchaseReceipt.findMany({ where: { companyId, supplierId: sp.id, status: 'POSTED' }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { id: true, number: true, receivedAt: true, dueDate: true, total: true, paidTotal: true } });
    const items = rows
      .map((s) => ({ kind: 'RECEIPT' as const, id: s.id, number: s.number, date: s.receivedAt.toISOString(), dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : null, total: m(s.total), paid: m(s.paidTotal), owed: D(s.total.toString()).minus(D(s.paidTotal.toString())).toFixed(4), overdue: !!s.dueDate && s.dueDate.getTime() < today }))
      .filter((s) => D(s.owed).gt(0));
    return { party: { id: sp.id, name: sp.name }, balance: (await supplierBalances(tx, companyId, [sp.id])).get(sp.id)!, items };
  });
}

const MAX_STATEMENT_ROWS = 2000;

/**
 * A statement read straight from the ledger: what was charged, what was paid (and every cancellation), with a running balance.
 * A positive balance means money is still owed (by the customer, or to the supplier).
 */
export async function statement(auth: AuthContext, q: StatementQuery) {
  if (!scopeFor(auth, 'payments.view')) throw forbidden();
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const isCustomer = !!q.customerId;
    const partyId = (q.customerId ?? q.supplierId)!;
    const party = isCustomer
      ? await tx.customer.findFirst({ where: { id: partyId, companyId }, select: { id: true, code: true, name: true } })
      : await tx.supplier.findFirst({ where: { id: partyId, companyId }, select: { id: true, code: true, name: true } });
    if (!party) throw notFound(isCustomer ? 'Customer not found' : 'Supplier not found');
    const key = isCustomer ? 'AR_CUSTOMERS' : 'AP_SUPPLIERS';
    const col = isCustomer ? 'customerId' : 'supplierId';
    // The column name is one of two fixed words chosen above, never user input. "charge" adds to what is owed, "paid" reduces it.
    const charge = isCustomer ? 'jl.debit' : 'jl.credit';
    const paid = isCustomer ? 'jl.credit' : 'jl.debit';
    const from = q.from ?? null;
    const to = q.to ?? null;
    const opening = from
      ? D((await tx.$queryRawUnsafe<{ b: string | null }[]>(
          `SELECT SUM(${charge} - ${paid})::numeric(19,4)::text AS b FROM journal_lines jl JOIN journal_entries je ON je.id = jl."entryId" JOIN accounts a ON a.id = jl."accountId"
           WHERE jl."companyId" = $1::uuid AND a."systemKey" = $2 AND jl."${col}" = $3::uuid AND je."entryDate" < $4::date`, companyId, key, partyId, from))[0]?.b ?? '0')
      : ZERO;
    const rows = await tx.$queryRawUnsafe<{ date: Date; entry: string; description: string; sourceId: string | null; charge: string; paid: string }[]>(
      `SELECT je."entryDate" AS date, je.number AS entry, je.description, je."sourceId"::text AS "sourceId", (${charge})::text AS charge, (${paid})::text AS paid
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl."entryId" JOIN accounts a ON a.id = jl."accountId"
       WHERE jl."companyId" = $1::uuid AND a."systemKey" = $2 AND jl."${col}" = $3::uuid
         AND ($4::date IS NULL OR je."entryDate" >= $4::date) AND ($5::date IS NULL OR je."entryDate" <= $5::date)
       ORDER BY je."entryDate", je."createdAt", jl.id LIMIT ${MAX_STATEMENT_ROWS + 1}`, companyId, key, partyId, from, to);
    if (rows.length > MAX_STATEMENT_ROWS) throw new AppError(400, 'RANGE_TOO_LARGE', 'That is too many lines for one statement. Choose a shorter date range.');

    // Name the document behind each line (invoice, payment or bill number).
    const ids = [...new Set(rows.flatMap((r) => (r.sourceId ? [r.sourceId] : [])))];
    const names = new Map<string, { kind: string; number: string }>();
    if (ids.length > 0) {
      for (const s of await tx.sale.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } })) names.set(s.id, { kind: 'SALE', number: s.number });
      for (const s of await tx.payment.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } })) names.set(s.id, { kind: 'PAYMENT', number: s.number });
      for (const s of await tx.purchaseReceipt.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } })) names.set(s.id, { kind: 'RECEIPT', number: s.number });
    }
    let run = opening;
    const lines = rows.map((r) => {
      run = run.plus(D(r.charge)).minus(D(r.paid));
      const doc = r.sourceId ? names.get(r.sourceId) : undefined;
      return { date: r.date.toISOString().slice(0, 10), entry: r.entry, description: r.description, document: doc ? { ...doc, id: r.sourceId! } : null, charge: D(r.charge).toFixed(4), paid: D(r.paid).toFixed(4), balance: run.toFixed(4) };
    });
    return {
      party: { kind: isCustomer ? 'CUSTOMER' : 'SUPPLIER', id: party.id, code: party.code, name: party.name },
      from, to,
      openingBalance: opening.toFixed(4),
      lines,
      closingBalance: run.toFixed(4),
    };
  });
}