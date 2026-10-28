import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import { lockBalance, postStockMovement, reverseStockMovement } from '../../inventory/stock.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D, storeCost, storeMoney } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { can, scopeFor, type Permission } from '../auth/permissions.js';
import { checkQuantity, splitIntoPackages, toBase } from '../products/units.js';
import type { AdjustmentInput, MovementListQuery, OpeningInput, StockListQuery } from './stock.schemas.js';
import type { Decimal } from 'decimal.js';

// What this file adds on top of the stock engine (src/inventory/stock.ts):
//  * who may see which locations, and who may see costs (cost.view)
//  * converting what a person types ("3 x Sack 50 kg") into base units, with the whole-pieces rule
//  * opening stock (the starting balance, Admin only), manual adjustments and write-offs, and reversing a manual mistake
//  * the accounting entry for each manual movement, saved in the same transaction

const todayUtc = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

/** The locations a person may look at for a permission: everything, or just their own. */
export function visibleLocations(auth: AuthContext, perm: Permission): 'all' | string[] {
  const scope = scopeFor(auth, perm);
  if (scope === 'company') return 'all';
  if (scope === 'location') return auth.locationIds;
  return [];
}

function assertCanAt(auth: AuthContext, perm: Permission, locationId: string) {
  if (!can(auth, perm, { locationId })) throw forbidden('You can only change stock at your own locations');
}

/** What the person typed, as base units and a cost per base unit. */
export async function toBaseTerms(
  tx: Tx,
  companyId: string,
  a: {
    productId: string;
    unitId?: string | undefined;
    quantity: string;
    unitCost?: string;
    allowZero?: boolean
}) {
  const product = await tx.product.findFirst({ where: { id: a.productId, companyId }, include: { productUnits: true } });
  if (!product) throw notFound('Product not found');
  const unit = a.unitId ? product.productUnits.find((u) => u.id === a.unitId) : product.productUnits.find((u) => u.isBase);
  if (!unit) throw badRequest(`That unit does not belong to "${product.name}"`);
  if (unit.status !== 'ACTIVE') throw badRequest(`The unit "${unit.name}" is switched off`);
  const factor = D(unit.factorToBase.toString());
  const problem = a.allowZero && D(a.quantity).isZero() ? null : checkQuantity(product.allowFractions, a.quantity, factor);
  if (problem) throw badRequest(`${product.name}: ${problem}`);
  return {
    product,
    unit,
    baseQty: toBase(a.quantity, factor),
    baseCost: a.unitCost === undefined ? undefined : storeCost(D(a.unitCost).div(factor)),
  };
}

// ───────────────────────── reading ─────────────────────────

const balanceInclude = {
  location: { select: { id: true, name: true, code: true } },
  product: {
    select: {
      id: true,
      sku: true,
      name: true,
      baseUnit: true,
      allowFractions: true,
      category: { select: { id: true, name: true } },
      productUnits: { where: { status: 'ACTIVE' as const }, select: { name: true, factorToBase: true } },
    },
  },
} satisfies Prisma.StockBalanceInclude;

export async function listStock(auth: AuthContext, q: StockListQuery) {
  const visible = visibleLocations(auth, 'stock.view');
  const seeCost = can(auth, 'cost.view');
  return withTenant(auth, async (tx) => {
    const locFilter: Prisma.StockBalanceWhereInput =
      visible === 'all' ? (q.locationId ? { locationId: q.locationId } : {}) : { locationId: q.locationId ? (visible.includes(q.locationId) ? q.locationId : '00000000-0000-0000-0000-000000000000') : { in: visible } };
    const where: Prisma.StockBalanceWhereInput = {
      companyId: auth.companyId,
      ...locFilter,
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.inStock === 'true' ? { onHand: { gt: 0 } } : {}),
      product: {
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
    };
    const rows = await tx.stockBalance.findMany({
      where,
      include: balanceInclude,
      orderBy: [{ product: { name: 'asc' } }, { id: 'asc' }],
      ...pageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      items: page.items.map((b) => {
        const onHand = D(b.onHand.toString());
        const committed = D(b.committed.toString());
        const avg = D(b.avgCost.toString());
        return {
          id: b.id,
          location: b.location,
          product: { id: b.product.id, sku: b.product.sku, name: b.product.name, baseUnit: b.product.baseUnit, allowFractions: b.product.allowFractions, category: b.product.category },
          onHand: onHand.toFixed(),
          committed: committed.toFixed(),
          available: onHand.minus(committed).toFixed(),
          packages: splitIntoPackages(onHand, b.product.productUnits.map((u) => ({ name: u.name, factor: u.factorToBase.toString() }))),
          avgCost: seeCost ? avg.toFixed(6) : null,
          value: seeCost ? storeMoney(onHand.times(avg)).toFixed(4) : null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  });
}

export async function listMovements(auth: AuthContext, q: MovementListQuery) {
  const visible = visibleLocations(auth, 'stock.view');
  const seeCost = can(auth, 'cost.view');
  return withTenant(auth, async (tx) => {
    const none = '00000000-0000-0000-0000-000000000000';
    const locFilter: Prisma.StockMovementWhereInput =
      visible === 'all' ? (q.locationId ? { locationId: q.locationId } : {}) : { locationId: q.locationId ? (visible.includes(q.locationId) ? q.locationId : none) : { in: visible } };
    const rows = await tx.stockMovement.findMany({
      where: { companyId: auth.companyId, ...locFilter, ...(q.productId ? { productId: q.productId } : {}), ...(q.type ? { type: q.type } : {}) },
      include: {
        location: { select: { id: true, name: true } },
        product: { select: { id: true, sku: true, name: true, baseUnit: true } },
        reversedBy: { select: { id: true } },
      },
      orderBy: [{ seq: 'desc' }],
      ...pageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return {
      items: page.items.map((m) => ({
        id: m.id,
        seq: m.seq.toString(),
        occurredAt: m.occurredAt.toISOString(),
        location: m.location,
        product: m.product,
        type: m.type,
        quantity: D(m.quantity.toString()).toFixed(),
        unitCost: seeCost ? D(m.unitCost.toString()).toFixed(6) : null,
        totalCost: seeCost ? D(m.totalCost.toString()).toFixed(4) : null,
        refType: m.refType,
        refId: m.refId,
        reason: m.reason,
        reversalOfId: m.reversalOfId,
        reversed: m.reversedBy !== null,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

// ───────────────────────── opening stock ─────────────────────────

/**
 * The starting balance, product by product. Admin only (import.run). A product that already has any stock
 * history here is refused: opening stock is the first entry, anything later is an adjustment or a purchase.
 */
export async function postOpening(auth: AuthContext, input: OpeningInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const docId = randomUUID();
    const created: { movementId: string; productId: string; quantity: string; unitCost: string; totalCost: string }[] = [];
    for (const line of input.lines) {
      const t = await toBaseTerms(tx, companyId, { productId: line.productId, unitId: line.unitId, quantity: line.quantity, unitCost: line.unitCost });
      const history = await tx.stockMovement.findFirst({ where: { companyId, locationId: input.locationId, productId: line.productId }, select: { id: true } });
      if (history) throw conflict(`"${t.product.name}" already has stock history here, so opening stock cannot be entered. Use an adjustment instead.`);
      const r = await postStockMovement(tx, {
        companyId,
        userId: auth.userId,
        locationId: input.locationId,
        productId: line.productId,
        type: 'OPENING',
        quantity: t.baseQty,
        unitCost: t.baseCost!,
        refType: 'OPENING',
        refId: docId,
        reason: input.note ?? 'Opening stock',
      });
      if (r.totalCost.gt(0)) {
        await postJournal(tx, { companyId, userId: auth.userId, draft: posting.openingStock({ locationId: input.locationId, cost: r.totalCost }), entryDate: todayUtc(), sourceId: r.movementId });
      }
      created.push({ movementId: r.movementId, productId: line.productId, quantity: r.quantity.toFixed(), unitCost: r.unitCost.toFixed(6), totalCost: r.totalCost.toFixed(4) });
    }
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'stock.opening', entityType: 'location', entityId: input.locationId, after: { document: docId, products: created.length }, ip });
    return { document: docId, created };
  });
}

// ───────────────────────── adjustments ─────────────────────────

/**
 * A manual stock change at one location: found stock, a loss, or damaged/expired goods (reason required).
 * Stock that is found comes in at the current average cost, so it never changes the average. Needs stock.adjust_approve
 * at that location.
 */

export async function postAdjustment(auth: AuthContext, input: AdjustmentInput, ip?: string) {
  assertCanAt(auth, 'stock.adjust_approve', input.locationId);
  return withTenant(auth, async (tx) => {
    const t = await toBaseTerms(tx, auth.companyId, { productId: input.productId, unitId: input.unitId, quantity: input.quantity });
    const r = await applyAdjustment(tx, auth, {
      locationId: input.locationId,
      productId: input.productId,
      productName: t.product.name,
      direction: input.direction,
      kind: input.kind,
      baseQty: t.baseQty,
      reason: input.reason,
      refType: 'MANUAL',
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: input.kind === 'DAMAGE' ? 'stock.damage' : 'stock.adjustment',
      entityType: 'product',
      entityId: input.productId,
      after: { location: input.locationId, direction: input.direction, quantityBase: r.quantity.abs().toFixed(), reason: input.reason },
      ip,
    });
    return {
      movementId: r.movementId,
      quantity: r.quantity.toFixed(),
      onHand: r.onHand.toFixed(),
      ...(can(auth, 'cost.view') ? { unitCost: r.unitCost.toFixed(6), totalCost: r.totalCost.toFixed(4), avgCost: r.avgCost.toFixed(6) } : {}),
    };
  });
}

/**
 * The one place a manual change to stock is applied (found stock, loss, damage, and approved count differences):
 * the stock movement and its accounting entry, in the caller's transaction. Found stock comes in at the current
 * average cost, so it never changes the average.
 */
export async function applyAdjustment(
  tx: Tx,
  auth: AuthContext,
  a: { locationId: string; productId: string; productName: string; direction: 'IN' | 'OUT'; kind: 'ADJUSTMENT' | 'DAMAGE'; baseQty: Decimal; reason: string; refType: string; refId?: string },
) {
  const bal = await lockBalance(tx, auth.companyId, a.locationId, a.productId);
  const going = a.direction === 'IN';
  const avg = D(bal.avgCost);
  if (going && avg.lte(0)) {
    throw badRequest(`"${a.productName}" has no known cost here, so stock cannot simply be added. Ask the Admin to enter it as opening stock or receive it with a cost.`);
  }
  const r = await postStockMovement(tx, {
    companyId: auth.companyId,
    userId: auth.userId,
    locationId: a.locationId,
    productId: a.productId,
    type: a.kind === 'DAMAGE' ? 'DAMAGE' : 'ADJUSTMENT',
    quantity: going ? a.baseQty : a.baseQty.neg(),
    ...(going ? { unitCost: avg } : {}),
    refType: a.refType,
    ...(a.refId ? { refId: a.refId } : {}),
    reason: a.reason,
  });
  if (!r.totalCost.isZero()) {
    await postJournal(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      draft:
        a.kind === 'DAMAGE'
          ? posting.stockDamage({ locationId: a.locationId, cost: r.totalCost.abs() })
          : posting.stockAdjustment({ locationId: a.locationId, lossValue: going ? r.totalCost.neg() : r.totalCost.abs() }),
      entryDate: todayUtc(),
      sourceId: r.movementId,
    });
  }
  return r;
}

// ───────────────────────── reversing a manual mistake ─────────────────────────

/**
 * Cancels an opening, adjustment or damage entry made by mistake: posts the exact opposite movement and the
 * mirror accounting entry. Only the newest movement of that product here can be reversed (so stock and cost go
 * back exactly); anything linked to a document (a purchase, a sale) is reversed through that document instead.
 */
export async function reverseMovement(auth: AuthContext, id: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const m = await tx.stockMovement.findFirst({ where: { id, companyId } });
    if (!m) throw notFound('Stock movement not found');
    if (!['OPENING', 'ADJUSTMENT', 'DAMAGE'].includes(m.type) || !['OPENING', 'MANUAL'].includes(m.refType)) {
      throw badRequest('Only a manual stock entry can be reversed here. A purchase, sale or transfer is cancelled through its own document.');
    }
    if (m.type === 'OPENING') {
      if (!can(auth, 'import.run')) throw forbidden('Only the Admin can reverse opening stock');
    } else {
      assertCanAt(auth, 'stock.adjust_approve', m.locationId);
    }

    const r = await reverseStockMovement(tx, { companyId, userId: auth.userId }, id, reason);
    const entry = await tx.journalEntry.findFirst({ where: { companyId, sourceId: id, reversalOfId: null }, select: { id: true } });
    if (entry) await reverseJournal(tx, { companyId, userId: auth.userId }, entry.id, { date: todayUtc(), reason });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'stock.reversal', entityType: 'stock_movement', entityId: id, after: { reason, reversedType: m.type }, ip });
    return { movementId: r.movementId, reverses: id, quantity: r.quantity.toFixed(), onHand: r.onHand.toFixed() };
  });
}