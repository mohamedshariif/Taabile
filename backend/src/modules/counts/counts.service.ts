import type { Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import { lockBalance } from '../../inventory/stock.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { can } from '../auth/permissions.js';
import { applyAdjustment, toBaseTerms, visibleLocations } from '../stock/stock.service.js';
import type { CountListQuery, CreateCountInput } from './counts.schemas.js';

// A stock count: someone counts the shelf, a second person approves, and only then does stock change.
//   SUBMITTED -> (approve) -> APPROVED      the differences become stock adjustments (refType COUNT)
//   SUBMITTED -> (reject)  -> REJECTED      nothing changes
// The system's figure ("expected") is written down when the count is submitted. If stock moved after that
// (a sale, a delivery), approving is refused and the products must be counted again: otherwise the
// difference would blame the counter for goods that left legitimately.

const detailInclude = {
  location: { select: { id: true, name: true, code: true } },
  stockCountLines: { orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }], include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } } } },
} satisfies Prisma.StockCountInclude;
type Detail = Prisma.StockCountGetPayload<{ include: typeof detailInclude }>;

const q = (v: { toString(): string }) => D(v.toString()).toFixed();

function present(c: Detail) {
  return {
    id: c.id,
    number: c.number,
    status: c.status,
    location: c.location,
    countedAt: c.countedAt.toISOString(),
    countedById: c.countedById,
    approvedAt: c.approvedAt?.toISOString() ?? null,
    note: c.note,
    lines: c.stockCountLines.map((l) => ({
      id: l.id,
      product: l.product,
      expectedQty: q(l.expectedQty),
      countedQty: q(l.countedQty),
      difference: q(l.difference),
      reason: l.reason,
    })),
  };
}
const reload = async (tx: Tx, id: string) => ({ count: present(await tx.stockCount.findUniqueOrThrow({ where: { id }, include: detailInclude })) });

// ───────────────────────── reading ─────────────────────────

export async function listCounts(auth: AuthContext, f: CountListQuery) {
  const visible = visibleLocations(auth, 'stock.view');
  return withTenant(auth, async (tx) => {
    const none = '00000000-0000-4000-8000-000000000000';
    const loc: Prisma.StockCountWhereInput =
      visible === 'all' ? (f.locationId ? { locationId: f.locationId } : {}) : { locationId: f.locationId ? (visible.includes(f.locationId) ? f.locationId : none) : { in: visible } };
    const rows = await tx.stockCount.findMany({
      where: { companyId: auth.companyId, ...loc, ...(f.status ? { status: f.status } : {}) },
      include: { location: { select: { id: true, name: true, code: true } }, _count: { select: { stockCountLines: true } } },
      orderBy: [{ countedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(f),
    });
    const page = toPage(rows, f.limit);
    return {
      items: page.items.map((c) => ({ id: c.id, number: c.number, status: c.status, location: c.location, countedAt: c.countedAt.toISOString(), products: c._count.stockCountLines })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function getCount(auth: AuthContext, id: string) {
  const visible = visibleLocations(auth, 'stock.view');
  return withTenant(auth, async (tx) => {
    const c = await tx.stockCount.findFirst({ where: { id, companyId: auth.companyId }, include: detailInclude });
    if (!c || (visible !== 'all' && !visible.includes(c.locationId))) throw notFound('Stock count not found');
    return { count: present(c) };
  });
}

// ───────────────────────── submit ─────────────────────────

export async function submitCount(auth: AuthContext, input: CreateCountInput, ip?: string) {
  if (!can(auth, 'stock.count', { locationId: input.locationId })) throw forbidden('You can only count stock at your own locations');
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const loc = await tx.location.findFirst({ where: { id: input.locationId, companyId }, select: { name: true, status: true } });
    if (!loc) throw notFound('Location not found');
    if (loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off`);

    const lines = [];
    for (const l of input.lines) {
      const t = await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.countedQty, allowZero: true });
      if (t.product.status !== 'ACTIVE') throw badRequest(`"${t.product.name}" is switched off`);
      const bal = await tx.stockBalance.findUnique({ where: { locationId_productId: { locationId: input.locationId, productId: l.productId } }, select: { onHand: true } });
      const expected = D(bal?.onHand.toString() ?? '0');
      lines.push({ companyId, productId: l.productId, expectedQty: expected.toString(), countedQty: t.baseQty.toString(), difference: t.baseQty.minus(expected).toString(), reason: l.reason ?? null });
    }
    const number = await nextDocumentNumber(tx, companyId, 'CNT', { prefix: 'SC' });
    const created = await tx.stockCount.create({
      data: { companyId, number, locationId: input.locationId, status: 'SUBMITTED', countedAt: new Date(), countedById: auth.userId, note: input.note ?? null, stockCountLines: { create: lines } },
      select: { id: true },
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'count.submitted', entityType: 'stock_count', entityId: created.id, after: { number, products: lines.length }, ip });
    return reload(tx, created.id);
  });
}

// ───────────────────────── approve / reject ─────────────────────────

/** A different person than the counter approves (the Admin may approve their own count). */
function assertMayDecide(auth: AuthContext, c: { locationId: string; countedById: string }) {
  if (!can(auth, 'stock.adjust_approve', { locationId: c.locationId })) throw forbidden('Only a Manager or Admin of this place can decide on a stock count');
  if (c.countedById === auth.userId && auth.role !== 'ADMIN') throw forbidden('Someone else must approve your count');
}

export async function approveCount(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const c = await tx.stockCount.findFirst({ where: { id, companyId }, include: { stockCountLines: { include: { product: { select: { name: true } } } } } });
    if (!c) throw notFound('Stock count not found');
    assertMayDecide(auth, c);
    if (c.status !== 'SUBMITTED') throw conflict(`This count is already ${c.status.toLowerCase()}`);

    // Lock every product first, in a fixed order, and make sure nothing moved since it was counted.
    const lines = [...c.stockCountLines].sort((a, b) => a.productId.localeCompare(b.productId));
    const moved: string[] = [];
    for (const l of lines) {
      const bal = await lockBalance(tx, companyId, c.locationId, l.productId);
      if (!D(bal.onHand).equals(D(l.expectedQty.toString()))) moved.push(`${l.product.name} (was ${D(l.expectedQty.toString()).toFixed()} when counted, now ${D(bal.onHand).toFixed()})`);
    }
    if (moved.length > 0) throw conflict(`Stock changed after the count, so it cannot be approved. Count again: ${moved.join('; ')}`);

    let adjusted = 0;
    for (const l of lines) {
      const diff = D(l.difference.toString());
      if (diff.isZero()) continue;
      await applyAdjustment(tx, auth, {
        locationId: c.locationId,
        productId: l.productId,
        productName: l.product.name,
        direction: diff.gt(0) ? 'IN' : 'OUT',
        kind: 'ADJUSTMENT',
        baseQty: diff.abs(),
        reason: l.reason ?? `Stock count ${c.number}`,
        refType: 'COUNT',
        refId: c.id,
      });
      adjusted++;
    }
    await tx.stockCount.update({ where: { id }, data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date() } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'count.approved', entityType: 'stock_count', entityId: id, after: { number: c.number, adjusted }, ip });
    return reload(tx, id);
  });
}

export async function rejectCount(auth: AuthContext, id: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const c = await tx.stockCount.findFirst({ where: { id, companyId: auth.companyId } });
    if (!c) throw notFound('Stock count not found');
    assertMayDecide(auth, c);
    if (c.status !== 'SUBMITTED') throw conflict(`This count is already ${c.status.toLowerCase()}`);
    await tx.stockCount.update({ where: { id }, data: { status: 'REJECTED', note: [c.note, `Rejected: ${reason}`].filter(Boolean).join('\n') } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'count.rejected', entityType: 'stock_count', entityId: id, after: { number: c.number, reason }, ip });
    return reload(tx, id);
  });
}