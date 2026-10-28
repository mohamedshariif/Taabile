import type { MovementType, StockMovement } from '@prisma/client';
import { Decimal } from 'decimal.js';
import type { Tx } from '../db/client.js';
import { AppError, badRequest, conflict, notFound } from '../shared/errors.js';
import { D, storeCost, storeMoney, storeQty, type Numeric } from '../shared/money.js';
import { costingFor, type CostState } from './costing.js';

// THE ONLY place that changes stock. Sales, purchases, transfers, counts and adjustments all call
// postStockMovement() inside their own transaction, so the document, its stock movement and its
// accounting entry commit together or not at all.
//
// For one product at one location it:
//   1. takes a lock on the stock row, so two people moving the same product take turns
//   2. refuses to go below zero (or below what is reserved for sales)
//   3. asks the costing method what the goods cost
//   4. writes one movement (append-only) and updates the balance
// The database then double-checks: balance = sum of movements, never negative, sign matches the type.

export const IN_TYPES: MovementType[] = [
  'OPENING',
  'RECEIPT',
  'TRANSFER_IN',
  'RETURN_IN'
];
export const OUT_TYPES: MovementType[] = [
  'TRANSFER_OUT',
  'SALE_RELEASE',
  'RETURN_OUT',
  'DAMAGE'
];

export interface MovementInput {
  companyId: string;
  userId: string;
  locationId: string;
  productId: string;
  type: Exclude<MovementType, 'REVERSAL'>;
  /** In BASE units. Positive = stock arrives, negative = stock leaves. Must agree with `type`. */
  quantity: Numeric;
  /** Cost per base unit. Required for arrivals; ignored for goods leaving (they leave at the average cost). */
  unitCost?: Numeric;
  refType: string;
  refId?: string | null;
  reason?: string | null;
  occurredAt?: Date;
}

export interface MovementResult {
  movementId: string;
  quantity: Decimal;
  unitCost: Decimal;
  totalCost: Decimal; // signed like the quantity: the change in stock value
  onHand: Decimal;
  avgCost: Decimal;
}

interface BalanceRow {
  id: string;
  onHand: string;
  committed: string;
  avgCost: string;
}

/** Finds (or creates) the stock row for this product here and locks it until the transaction ends. */
export async function lockBalance(tx: Tx, companyId: string, locationId: string, productId: string): Promise<BalanceRow> {
  await tx.$executeRaw`
    INSERT INTO stock_balances (id, "companyId", "locationId", "productId", "updatedAt")
    VALUES (gen_random_uuid(), ${companyId}::uuid, ${locationId}::uuid, ${productId}::uuid, now())
    ON CONFLICT ("locationId", "productId") DO NOTHING`;
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT id::text, "onHand"::text, committed::text, "avgCost"::text FROM stock_balances
    WHERE "companyId" = ${companyId}::uuid AND "locationId" = ${locationId}::uuid AND "productId" = ${productId}::uuid
    FOR UPDATE`;
  return rows[0]!;
}

async function checkPlaceAndProduct(tx: Tx, a: { companyId: string; locationId: string; productId: string; arriving: boolean }) {
  const [loc, product] = await Promise.all([
    tx.location.findFirst({ where: { id: a.locationId, companyId: a.companyId }, select: { name: true, status: true } }),
    tx.product.findFirst({ where: { id: a.productId, companyId: a.companyId }, select: { name: true, status: true, allowFractions: true, baseUnit: true } }),
  ]);
  if (!loc) throw notFound('Location not found');
  if (!product) throw notFound('Product not found');
  if (a.arriving && loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off, so it cannot receive stock`);
  if (a.arriving && product.status !== 'ACTIVE') throw badRequest(`"${product.name}" is switched off, so it cannot receive stock`);
  return { loc, product };
}

export const insufficientStock = (product: string, unit: string, location: string, available: Numeric, wanted: Numeric) =>
  new AppError(
    409,
    'INSUFFICIENT_STOCK',
    `Not enough "${product}" at ${location}: ${D(available).toFixed()} ${unit} available, ${D(wanted).toFixed()} ${unit} needed`,
  );

export async function postStockMovement(tx: Tx, m: MovementInput): Promise<MovementResult> {
  const qty = storeQty(m.quantity);
  if (qty.isZero()) throw badRequest('Quantity cannot be zero');
  const arriving = qty.gt(0);
  if (IN_TYPES.includes(m.type) && !arriving) throw badRequest(`A ${m.type.toLowerCase()} movement must add stock`);
  if (OUT_TYPES.includes(m.type) && arriving) throw badRequest(`A ${m.type.toLowerCase()} movement must remove stock`);
  if (D(m.quantity).decimalPlaces() > 4) throw badRequest('Quantities have at most 4 decimals');

  const { loc, product } = await checkPlaceAndProduct(tx, { companyId: m.companyId, locationId: m.locationId, productId: m.productId, arriving });
  if (!product.allowFractions && !qty.isInteger()) {
    throw badRequest(`"${product.name}" is counted in whole ${product.baseUnit}s, so ${qty.abs().toFixed()} is not allowed`);
  }
  if (arriving && m.unitCost === undefined) throw badRequest('Arriving stock needs a cost');
  if (arriving && D(m.unitCost!).lt(0)) throw badRequest('A cost cannot be negative');

  const bal = await lockBalance(tx, m.companyId, m.locationId, m.productId);
  const state: CostState = { onHand: D(bal.onHand), avgCost: D(bal.avgCost) };
  const method = costingFor(m.companyId);
  const scope = { tx, companyId: m.companyId, locationId: m.locationId, productId: m.productId };

  let next: CostState;
  let unitCost: Decimal;
  if (arriving) {
    unitCost = storeCost(m.unitCost!);
    next = await method.receive(scope, state, qty, unitCost);
  } else {
    const available = state.onHand.minus(D(bal.committed));
    if (qty.abs().gt(available)) throw insufficientStock(product.name, product.baseUnit, loc.name, available, qty.abs());
    const issued = await method.issue(scope, state, qty.abs());
    unitCost = issued.unitCost;
    next = issued.state;
  }
  const totalCost = storeMoney(qty.times(unitCost));
  return write(tx, m, 
    {
      qty,
      unitCost,
      totalCost,
      next,
      balanceId: bal.id,
      type: m.type,
      before: state.avgCost 
    });
}

async function write(
  tx: Tx,
  m: Pick<MovementInput, 'companyId' | 'userId' | 'locationId' | 'productId' | 'refType' | 'refId' | 'reason' | 'occurredAt'> & { reversalOfId?: string },
  r: { qty: Decimal; unitCost: Decimal; totalCost: Decimal; next: CostState; balanceId: string; type: MovementType; before: Decimal },
): Promise<MovementResult> {
  const row = await tx.stockMovement.create({
    data: {
      companyId: m.companyId,
      locationId: m.locationId,
      productId: m.productId,
      type: r.type,
      quantity: r.qty.toString(),
      unitCost: r.unitCost.toString(),
      totalCost: r.totalCost.toString(),
      avgCostBefore: r.before.toString(),
      refType: m.refType,
      refId: m.refId ?? null,
      reason: m.reason ?? null,
      occurredAt: m.occurredAt ?? new Date(),
      createdById: m.userId,
      reversalOfId: m.reversalOfId ?? null,
    },
    select: { id: true },
  });
  await tx.stockBalance.update({
    where: { id: r.balanceId },
    data: { onHand: r.next.onHand.toString(), avgCost: r.next.avgCost.toString() },
  });
  return { movementId: row.id, quantity: r.qty, unitCost: r.unitCost, totalCost: r.totalCost, onHand: r.next.onHand, avgCost: r.next.avgCost };
}

/**
 * Undoes one movement by posting its exact opposite (the original is never touched).
 * Allowed only when nothing newer is still in effect for that product at that location, so the stock and its
 * average cost go back exactly to what they were. Anything newer must be reversed first, newest to oldest.
 */
export async function reverseStockMovement(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  movementId: string,
  reason: string,
): Promise<MovementResult & { original: StockMovement }> {
  const original = await tx.stockMovement.findFirst({ where: { id: movementId, companyId: ctx.companyId }, include: { reversedBy: { select: { id: true } } } });
  if (!original) throw notFound('Stock movement not found');
  if (original.type === 'REVERSAL') throw badRequest('A reversal cannot be reversed again. Post a new movement instead.');
  if (original.reversedBy) throw conflict('This movement has already been reversed');

  const bal = await lockBalance(tx, ctx.companyId, original.locationId, original.productId);
  // Newer movements only block this when they are still in effect. A newer movement that was already reversed
  // (and the reversal itself) cancel each other out and leave stock and cost exactly as they were just after this one.
  const newer = await tx.stockMovement.findFirst({
    where: {
      companyId: ctx.companyId,
      locationId: original.locationId,
      productId: original.productId,
      seq: { gt: original.seq },
      type: { not: 'REVERSAL' },
      reversedBy: { is: null },
    },
    select: { type: true },
  });
  if (newer) {
    throw conflict('Newer stock movements exist for this product here. Reverse them first (newest first), or post an adjustment instead.');
  }

  const state: CostState = { onHand: D(bal.onHand), avgCost: D(bal.avgCost) };
  const qty = D(original.quantity.toString());
  const back = qty.neg();
  if (back.lt(0)) {
    const available = state.onHand.minus(D(bal.committed));
    if (back.abs().gt(available)) {
      const p = await tx.product.findUniqueOrThrow({ where: { id: original.productId }, select: { name: true, baseUnit: true } });
      const l = await tx.location.findUniqueOrThrow({ where: { id: original.locationId }, select: { name: true } });
      throw insufficientStock(p.name, p.baseUnit, l.name, available, back.abs());
    }
  }
  const unitCost = D(original.unitCost.toString());
  const next = await costingFor(ctx.companyId).undo({ 
    tx,
    companyId: ctx.companyId,
    locationId: original.locationId,
    productId: original.productId 
  },
  state,
  qty,
  unitCost,
  original.avgCostBefore?.toString() ?? null
);

  const res = await write(
    tx,
    { companyId: ctx.companyId, userId: ctx.userId, locationId: original.locationId, productId: original.productId, refType: 'REVERSAL', refId: original.id, reason, reversalOfId: original.id },
    {
      qty: back,
      unitCost,
      totalCost: D(original.totalCost.toString()).neg(),
      next,
      balanceId: bal.id,
      type: 'REVERSAL',
      before: state.avgCost
    },
  );
  return { ...res, original };
}