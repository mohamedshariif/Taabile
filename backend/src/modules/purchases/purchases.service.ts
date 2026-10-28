import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant } from '../../db/client.js';
import { postStockMovement, reverseStockMovement } from '../../inventory/stock.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { allocateByWeight, D, storeCost, storeMoney, ZERO } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { can } from '../auth/permissions.js';
import { toBaseTerms } from '../stock/stock.service.js';
import type { CreateReceiptInput, ReceiptListQuery } from './purchases.schemas.js';

// A purchase receipt = goods arrive from a supplier. In ONE transaction it saves:
//   the receipt and its lines, the landed costs, one stock movement per line (RECEIPT, at the landed cost),
//   and one accounting entry (Dr Inventory; Cr what we owe the supplier, Cr cash/bank for costs paid now).
// Landed costs (freight, container, handling) are shared across the lines by value, so what the stock costs is
// what it really cost to get it into the store.

const midnightUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const today = () => new Date().toISOString().slice(0, 10);

function assertCanAt(auth: AuthContext, locationId: string) {
  if (!can(auth, 'purchases.manage', { locationId })) throw forbidden('You can only record purchases at your own locations');
}

const detailInclude = {
  supplier: { select: { id: true, code: true, name: true } },
  location: { select: { id: true, name: true, code: true } },
  purchaseReceiptLines: {
    orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }],
    include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } }, productUnit: { select: { id: true, name: true, factorToBase: true } } },
  },
  purchaseCosts: { orderBy: { id: 'asc' as const } },
} satisfies Prisma.PurchaseReceiptInclude;

type Detail = Prisma.PurchaseReceiptGetPayload<{ include: typeof detailInclude }>;

const money = (v: { toString(): string }) => D(v.toString()).toFixed(4);

function present(r: Detail) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    supplier: r.supplier,
    location: r.location,
    receivedAt: r.receivedAt.toISOString(),
    containerRef: r.containerRef,
    supplierInvoiceRef: r.supplierInvoiceRef,
    invoiceDate: r.invoiceDate?.toISOString().slice(0, 10) ?? null,
    dueDate: r.dueDate?.toISOString().slice(0, 10) ?? null,
    goodsTotal: money(r.goodsTotal),
    costTotal: money(r.costTotal),
    total: money(r.total), // what we owe the supplier for this receipt (goods + landed costs not paid yet)
    paidTotal: money(r.paidTotal),
    note: r.note,
    lines: r.purchaseReceiptLines.map((l) => ({
      id: l.id,
      product: l.product,
      unit: { id: l.productUnit.id, name: l.productUnit.name },
      qtyExpected: D(l.qtyExpected.toString()).toFixed(),
      qtyReceived: D(l.qtyReceived.toString()).toFixed(),
      qtyDamaged: D(l.qtyDamaged.toString()).toFixed(),
      qtyReceivedBase: D(l.qtyReceivedBase.toString()).toFixed(),
      unitPrice: money(l.unitCost),
      lineTotal: money(l.lineTotal),
      landedUnitCostBase: D(l.landedUnitCostBase.toString()).toFixed(6), // cost of one base unit including its share of the landed costs
    })),
    costs: r.purchaseCosts.map((c) => ({ id: c.id, type: c.type, amount: money(c.amount), note: c.note })),
  };
}

// ───────────────────────── reading ─────────────────────────

export async function listReceipts(auth: AuthContext, q: ReceiptListQuery) {
  return withTenant(auth, async (tx) => {
    const where: Prisma.PurchaseReceiptWhereInput = {
      companyId: auth.companyId,
      ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.status !== 'ALL' ? { status: q.status } : {}),
      ...(q.from || q.to ? { receivedAt: { ...(q.from ? { gte: midnightUtc(q.from) } : {}), ...(q.to ? { lt: new Date(midnightUtc(q.to).getTime() + 86_400_000) } : {}) } } : {}),
      ...(q.search
        ? { OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { supplierInvoiceRef: { contains: q.search, mode: 'insensitive' } }, { containerRef: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const rows = await tx.purchaseReceipt.findMany({
      where,
      include: { supplier: { select: { id: true, code: true, name: true } }, location: { select: { id: true, name: true, code: true } } },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      items: page.items.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        supplier: r.supplier,
        location: r.location,
        receivedAt: r.receivedAt.toISOString(),
        supplierInvoiceRef: r.supplierInvoiceRef,
        containerRef: r.containerRef,
        goodsTotal: money(r.goodsTotal),
        costTotal: money(r.costTotal),
        total: money(r.total),
        paidTotal: money(r.paidTotal),
      })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function getReceipt(auth: AuthContext, id: string) {
  return withTenant(auth, async (tx) => {
    const r = await tx.purchaseReceipt.findFirst({ where: { id, companyId: auth.companyId }, include: detailInclude });
    if (!r) throw notFound('Purchase receipt not found');
    return { receipt: present(r) };
  });
}

// ───────────────────────── recording a receipt ─────────────────────────

export async function createReceipt(auth: AuthContext, input: CreateReceiptInput, ip?: string) {
  assertCanAt(auth, input.locationId);
  const receivedDay = input.receivedAt ?? today();
  if (receivedDay > today()) throw badRequest('The received date cannot be in the future');

  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, companyId }, select: { id: true, name: true, status: true } });
    if (!supplier) throw notFound('Supplier not found');
    if (supplier.status !== 'ACTIVE') throw badRequest(`"${supplier.name}" is switched off, so nothing can be received from them`);
    if (input.supplierInvoiceRef) {
      const dup = await tx.purchaseReceipt.findFirst({ where: { companyId, supplierId: supplier.id, supplierInvoiceRef: input.supplierInvoiceRef }, select: { number: true } });
      if (dup) throw conflict(`This supplier invoice was already recorded as ${dup.number}`);
    }

    // What was typed -> base units and money.
    const lines = [];
    for (const l of input.lines) {
      const damaged = D(l.qtyDamaged ?? '0');
      const t = await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.qtyReceived });
      if (!damaged.isZero()) {
        const problem = t.product.allowFractions || damaged.isInteger() ? null : `${t.product.name}: damaged quantity must be a whole number`;
        if (problem) throw badRequest(problem);
      }
      lines.push({
        productId: l.productId,
        productName: t.product.name,
        unitId: t.unit.id,
        qtyReceived: D(l.qtyReceived),
        qtyDamaged: damaged,
        qtyExpected: l.qtyExpected ? D(l.qtyExpected) : D(l.qtyReceived).plus(damaged),
        qtyBase: t.baseQty,
        unitPrice: D(l.unitPrice),
        lineTotal: storeMoney(D(l.qtyReceived).times(l.unitPrice)),
      });
    }

    // Landed costs: money accounts must be ours and switched on.
    const accountIds = [...new Set(input.costs.flatMap((c) => (c.paidFromAccountId ? [c.paidFromAccountId] : [])))];
    const accounts = await tx.financialAccount.findMany({ where: { companyId, id: { in: accountIds } }, select: { id: true, name: true, status: true, ledgerAccountId: true } });
    const ledgerOf = new Map(accounts.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const a = ledgerOf.get(id);
      if (!a) throw notFound('Money account not found');
      if (a.status !== 'ACTIVE') throw badRequest(`The account "${a.name}" is switched off`);
    }

    const goodsTotal = lines.reduce((s, l) => s.plus(l.lineTotal), ZERO);
    const costTotal = input.costs.reduce((s, c) => s.plus(c.amount), ZERO);
    const owedCosts = input.costs.filter((c) => !c.paidFromAccountId).reduce((s, c) => s.plus(c.amount), ZERO);

    // Share the landed costs across lines by value (by quantity when everything was free).
    const weights = goodsTotal.gt(0) ? lines.map((l) => l.lineTotal) : lines.map((l) => l.qtyBase);
    const shares = costTotal.gt(0) ? allocateByWeight(costTotal, weights) : lines.map(() => ZERO);

    const receiptId = randomUUID();
    const number = await nextDocumentNumber(tx, companyId, 'PUR', { prefix: 'PR' });
    const landed = lines.map((l, i) => storeCost(l.lineTotal.plus(shares[i]!).div(l.qtyBase)));

    await tx.purchaseReceipt.create({
      data: {
        id: receiptId,
        companyId,
        number,
        supplierId: supplier.id,
        locationId: input.locationId,
        containerRef: input.containerRef ?? null,
        supplierInvoiceRef: input.supplierInvoiceRef ?? null,
        invoiceDate: input.invoiceDate ? midnightUtc(input.invoiceDate) : null,
        dueDate: input.dueDate ? midnightUtc(input.dueDate) : null,
        receivedAt: input.receivedAt ? midnightUtc(input.receivedAt) : new Date(),
        goodsTotal: goodsTotal.toString(),
        costTotal: costTotal.toString(),
        total: goodsTotal.plus(owedCosts).toString(),
        createdById: auth.userId,
        note: input.note ?? null,
        purchaseReceiptLines: {
          create: lines.map((l, i) => ({
            companyId,
            productId: l.productId,
            productUnitId: l.unitId,
            qtyExpected: l.qtyExpected.toString(),
            qtyReceived: l.qtyReceived.toString(),
            qtyDamaged: l.qtyDamaged.toString(),
            qtyReceivedBase: l.qtyBase.toString(),
            unitCost: l.unitPrice.toString(),
            landedUnitCostBase: landed[i]!.toString(),
            lineTotal: l.lineTotal.toString(),
          })),
        },
        purchaseCosts: { create: input.costs.map((c) => ({ companyId, type: c.type, amount: c.amount, note: c.note ?? null })) },
      },
    });

    // Stock: one movement per line, valued at the landed cost.
    for (const [i, l] of lines.entries()) {
      await postStockMovement(tx, {
        companyId,
        userId: auth.userId,
        locationId: input.locationId,
        productId: l.productId,
        type: 'RECEIPT',
        quantity: l.qtyBase,
        unitCost: landed[i]!,
        refType: 'PURCHASE',
        refId: receiptId,
        reason: `Received ${number}`,
        occurredAt: input.receivedAt ? midnightUtc(input.receivedAt) : new Date(),
      });
    }

    // Accounting: Dr Inventory (goods + all costs); Cr supplier (goods + costs still owed); Cr cash/bank (costs paid now).
    if (goodsTotal.plus(costTotal).gt(0)) {
      await postJournal(tx, {
        companyId,
        userId: auth.userId,
        draft: posting.purchaseReceipt({
          supplierId: supplier.id,
          locationId: input.locationId,
          goodsValue: goodsTotal,
          costs: input.costs.map((c) => ({ amount: c.amount, ...(c.paidFromAccountId ? { paidFromAccountId: ledgerOf.get(c.paidFromAccountId)!.ledgerAccountId } : {}) })),
        }),
        entryDate: midnightUtc(receivedDay),
        sourceId: receiptId,
      });
    }
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'purchase.received', entityType: 'purchase_receipt', entityId: receiptId, after: { number, supplier: supplier.name, lines: lines.length, goodsTotal: goodsTotal.toFixed(4), costTotal: costTotal.toFixed(4) }, ip });

    const saved = await tx.purchaseReceipt.findUniqueOrThrow({ where: { id: receiptId }, include: detailInclude });
    return { receipt: present(saved) };
  });
}

// ───────────────────────── cancelling a receipt ─────────────────────────

/**
 * Cancels a receipt: puts the stock back out (exactly, at its cost) and reverses the accounting entry.
 * Refused when the goods can no longer be taken back: they were sold or moved (newer movements), or
 * something was already paid against it.
 */
export async function voidReceipt(auth: AuthContext, id: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const r = await tx.purchaseReceipt.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Purchase receipt not found');
    assertCanAt(auth, r.locationId);
    if (r.status === 'VOIDED') throw conflict('This receipt is already cancelled');
    if (D(r.paidTotal.toString()).gt(0)) throw conflict('A payment was already made against this receipt. Cancel the payment first.');

    const moves = await tx.stockMovement.findMany({ where: { companyId, refType: 'PURCHASE', refId: id, type: 'RECEIPT' }, orderBy: { seq: 'desc' }, select: { id: true } });
    for (const m of moves) {
      try {
        await reverseStockMovement(tx, { companyId, userId: auth.userId }, m.id, reason);
      } catch (e) {
        if (e instanceof Error && 'status' in e && (e as { status: number }).status === 409) {
          throw conflict(`This receipt cannot be cancelled because its goods were already used. ${e.message}`);
        }
        throw e;
      }
    }
    const entry = await tx.journalEntry.findFirst({ where: { companyId, sourceType: 'PURCHASE_RECEIPT', sourceId: id, reversalOfId: null }, select: { id: true } });
    if (entry) await reverseJournal(tx, { companyId, userId: auth.userId }, entry.id, { date: midnightUtc(today()), reason });
    await tx.purchaseReceipt.update({ where: { id }, data: { status: 'VOIDED' } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'purchase.voided', entityType: 'purchase_receipt', entityId: id, after: { number: r.number, reason }, ip });
    const saved = await tx.purchaseReceipt.findUniqueOrThrow({ where: { id }, include: detailInclude });
    return { receipt: present(saved) };
  });
}