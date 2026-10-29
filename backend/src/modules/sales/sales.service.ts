import type { Prisma } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import { insufficientStock, lockBalance, postStockMovement } from '../../inventory/stock.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { customerBalances } from '../../shared/balances.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D, roundMoney, storeMoney, ZERO } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { toDateOnly } from '../../shared/schemas.js';
import { can, scopeFor } from '../auth/permissions.js';
import { toBaseTerms } from '../stock/stock.service.js';
import type { CreateSaleInput, QuoteSaleInput, ReleaseInput, SaleListQuery } from './sales.schemas.js';

// A sale, in plain words:
//  * The seller picks products. Prices come from the price list (the customer's list, or the Retail/Wholesale default).
//    Changing a price (a discount) needs the discount permission. Selling below cost is refused, except for the Admin.
//  * Goods come from the selling place, plus optionally other places ("allocations"). What the selling place hands over
//    now leaves its stock immediately and its cost (COGS) is booked at once. What another place must supply is reserved
//    there ("committed") and leaves its stock only when that place RELEASES it; COGS is booked at release.
//  * Money taken now goes into a cash drawer or bank account. What is not paid stays owed (accounts receivable): that
//    needs a named customer who has a credit limit, and the sale must keep them within it.
//  * A posted sale is never edited. Voiding it puts the goods back at their original cost and reverses the accounting.

const todayUtc = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const q = (v: { toString(): string }) => D(v.toString()).toFixed();
const m = (v: { toString(): string }) => D(v.toString()).toFixed(4);

function assertSellsAt(auth: AuthContext, locationId: string) {
  const scope = scopeFor(auth, 'sales.create');
  if (!scope) throw forbidden();
  if (scope !== 'company' && !auth.locationIds.includes(locationId)) throw forbidden('You can only sell from your own place');
}

// ───────────────────────── working out a sale (shared by the quote and the real thing) ─────────────────────────

interface Part { locationId: string; locationName: string; qtyBase: Decimal; local: boolean }
interface PLine {
  productId: string;
  productName: string;
  baseUnit: string;
  unitId: string;
  unitName: string;
  factor: Decimal;
  quantity: Decimal;
  baseQty: Decimal;
  listPrice: Decimal | null;
  unitPrice: Decimal | null;
  lineTotal: Decimal;
  tax: Decimal;
  discount: Decimal;
  parts: Part[];
  problem?: string;
}

async function prepare(tx: Tx, auth: AuthContext, input: QuoteSaleInput, lenient: boolean) {
  const companyId = auth.companyId;
  assertSellsAt(auth, input.locationId);
  const loc = await tx.location.findFirst({ where: { id: input.locationId, companyId }, select: { id: true, name: true, status: true } });
  if (!loc) throw notFound('Location not found');
  if (loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off`);
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { taxRate: true } });
  const taxRate = D(company.taxRate.toString());

  const customer = input.customerId
    ? await tx.customer.findFirst({ where: { id: input.customerId, companyId }, include: { priceList: { select: { id: true, name: true, kind: true, status: true } } } })
    : null;
  if (input.customerId && !customer) throw notFound('Customer not found');
  if (customer && customer.status !== 'ACTIVE') throw badRequest(`"${customer.name}" is switched off`);

  let list = customer?.priceList && customer.priceList.status === 'ACTIVE' ? customer.priceList : null;
  const type = list ? list.kind : (input.type ?? 'RETAIL');
  if (!list) list = await tx.priceList.findFirst({ where: { companyId, kind: type, status: 'ACTIVE' }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }], select: { id: true, name: true, kind: true, status: true } });
  if (!list) throw badRequest(`There is no active ${type.toLowerCase()} price list. Ask the Admin to set one up.`);

  const mayDiscount = !!scopeFor(auth, 'sales.discount');
  const maySupply = !!scopeFor(auth, 'sales.supply_other_location');
  const otherIds = [...new Set(input.lines.flatMap((l) => (l.fromOther ?? []).map((o) => o.locationId)))];
  if (otherIds.length > 0 && !maySupply) throw forbidden('You are not allowed to supply goods from other places');
  const others = new Map((await tx.location.findMany({ where: { companyId, id: { in: otherIds } }, select: { id: true, name: true, status: true } })).map((l) => [l.id, l]));

  const lines: PLine[] = [];
  for (const l of input.lines) {
    const t = await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.quantity });
    if (t.product.status !== 'ACTIVE') throw badRequest(`"${t.product.name}" is switched off`);
    if (!t.unit.isSaleUnit) throw badRequest(`"${t.unit.name}" is not a selling unit for ${t.product.name}`);
    const pp = await tx.productPrice.findUnique({ where: { priceListId_productUnitId: { priceListId: list.id, productUnitId: t.unit.id } }, select: { price: true } });
    const listPrice = pp ? D(pp.price.toString()) : null;
    const typed = l.unitPrice !== undefined ? D(l.unitPrice) : null;
    if (typed && (!listPrice || !typed.equals(listPrice)) && !mayDiscount) throw forbidden('You are not allowed to change prices. Ask a Manager or the Admin.');
    const unitPrice = typed ?? listPrice;
    const quantity = D(l.quantity);
    const factor = D(t.unit.factorToBase.toString());

    const parts: Part[] = [];
    let other = ZERO;
    const seen = new Set<string>();
    for (const o of l.fromOther ?? []) {
      if (o.locationId === loc.id) throw badRequest(`${t.product.name}: the selling place does not need to be listed as "another place"`);
      if (seen.has(o.locationId)) throw badRequest(`${t.product.name}: the same place is listed twice`);
      seen.add(o.locationId);
      const ol = others.get(o.locationId);
      if (!ol) throw notFound('Location not found');
      if (ol.status !== 'ACTIVE') throw badRequest(`"${ol.name}" is switched off`);
      const ob = await toBaseTerms(tx, companyId, { productId: l.productId, unitId: t.unit.id, quantity: o.quantity });
      other = other.plus(ob.baseQty);
      parts.push({ locationId: ol.id, locationName: ol.name, qtyBase: ob.baseQty, local: false });
    }
    if (other.gt(t.baseQty)) throw badRequest(`${t.product.name}: more is taken from other places than is being sold`);
    const local = t.baseQty.minus(other);
    if (local.gt(0)) parts.unshift({ locationId: loc.id, locationName: loc.name, qtyBase: local, local: true });

    const pl: PLine = {
      productId: t.product.id, productName: t.product.name, baseUnit: t.product.baseUnit, unitId: t.unit.id, unitName: t.unit.name, factor, quantity, baseQty: t.baseQty,
      listPrice, unitPrice, lineTotal: ZERO, tax: ZERO, discount: ZERO, parts,
    };
    if (!unitPrice) {
      if (!lenient) throw badRequest(`There is no price for "${t.product.name}" (${t.unit.name}) on the "${list.name}" list. Ask the Admin to set one.`);
      pl.problem = `No price on the "${list.name}" list`;
    } else {
      pl.lineTotal = roundMoney(quantity.times(unitPrice));
      pl.tax = roundMoney(pl.lineTotal.times(taxRate).div(100));
      if (listPrice && unitPrice.lt(listPrice)) pl.discount = roundMoney(quantity.times(listPrice)).minus(pl.lineTotal);
    }
    lines.push(pl);
  }
  return { loc, customer, list, type, taxRate, lines };
}

const sum = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), ZERO);
function totalsOf(lines: PLine[]) {
  const net = sum(lines.map((l) => l.lineTotal));
  const discountTotal = sum(lines.map((l) => l.discount));
  const taxTotal = sum(lines.map((l) => l.tax));
  return { net, discountTotal, taxTotal, subtotal: net.plus(discountTotal), total: net.plus(taxTotal) };
}

/** Every (place, product) pair a sale touches, in one fixed order, so two sales never lock each other in a circle. */
const pairsOf = (lines: PLine[]) => {
  const map = new Map<string, { locationId: string; productId: string }>();
  for (const l of lines) for (const p of l.parts) map.set(`${p.locationId}:${l.productId}`, { locationId: p.locationId, productId: l.productId });
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
};
const worstCost = (l: PLine, bal: Map<string, { avgCost: string }>) =>
  l.parts.reduce((mx, p) => { const c = D(bal.get(`${p.locationId}:${l.productId}`)?.avgCost ?? '0'); return c.gt(mx) ? c : mx; }, ZERO);

/** What the screen shows while the seller is typing: exact prices, totals, stock here, and anything that would stop the sale. */
export async function quoteSale(auth: AuthContext, input: QuoteSaleInput) {
  return withTenant(auth, async (tx) => {
    const p = await prepare(tx, auth, input, true);
    const bal = new Map<string, { onHand: string; committed: string; avgCost: string }>();
    for (const pr of pairsOf(p.lines)) {
      const b = await tx.stockBalance.findUnique({ where: { locationId_productId: pr }, select: { onHand: true, committed: true, avgCost: true } });
      bal.set(`${pr.locationId}:${pr.productId}`, { onHand: b?.onHand.toString() ?? '0', committed: b?.committed.toString() ?? '0', avgCost: b?.avgCost.toString() ?? '0' });
    }
    const t = totalsOf(p.lines);
    return {
      priceList: { id: p.list.id, name: p.list.name },
      type: p.type,
      taxRate: p.taxRate.toFixed(),
      lines: p.lines.map((l) => ({
        productId: l.productId,
        unitId: l.unitId,
        listPrice: l.listPrice ? l.listPrice.toFixed(4) : null,
        unitPrice: l.unitPrice ? l.unitPrice.toFixed(4) : null,
        lineTotal: l.lineTotal.toFixed(2),
        tax: l.tax.toFixed(2),
        problem: l.problem ?? null,
        belowCost: !!l.unitPrice && worstCost(l, bal).gt(0) && l.unitPrice.lt(worstCost(l, bal).times(l.factor)),
        // How much of this product the selling place can hand over now (base units), and what is asked of each place.
        parts: l.parts.map((pt) => {
          const b = bal.get(`${pt.locationId}:${l.productId}`)!;
          return { locationId: pt.locationId, locationName: pt.locationName, qtyBase: pt.qtyBase.toFixed(), available: D(b.onHand).minus(D(b.committed)).toFixed(), enough: D(b.onHand).minus(D(b.committed)).gte(pt.qtyBase) };
        }),
      })),
      subtotal: t.subtotal.toFixed(2),
      discountTotal: t.discountTotal.toFixed(2),
      taxTotal: t.taxTotal.toFixed(2),
      total: t.total.toFixed(2),
    };
  });
}

// ───────────────────────── presenting ─────────────────────────

const detailInclude = {
  location: { select: { id: true, name: true, code: true } },
  customer: { select: { id: true, code: true, name: true } },
  saleLines: {
    orderBy: { id: 'asc' as const },
    include: {
      product: { select: { id: true, sku: true, name: true, baseUnit: true } },
      productUnit: { select: { id: true, name: true, factorToBase: true } },
      saleLineAllocations: { orderBy: { id: 'asc' as const }, include: { supplyLocation: { select: { id: true, name: true, code: true } } } },
    },
  },
  paymentAllocations: { orderBy: { createdAt: 'asc' as const }, include: { payment: { include: { financialAccount: { select: { id: true, name: true, type: true } } } } } },
  saleReleases: { orderBy: { releasedAt: 'asc' as const }, include: { location: { select: { id: true, name: true } } } },
} satisfies Prisma.SaleInclude;
type Detail = Prisma.SaleGetPayload<{ include: typeof detailInclude }>;

function present(s: Detail) {
  const owed = D(s.total.toString()).minus(D(s.paidTotal.toString()));
  return {
    id: s.id,
    number: s.number,
    status: s.status,
    type: s.type,
    paymentStatus: s.paymentStatus,
    fulfillmentStatus: s.fulfillmentStatus,
    location: s.location,
    customer: s.customer,
    soldAt: s.soldAt.toISOString(),
    dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : null,
    subtotal: m(s.subtotal),
    discountTotal: m(s.discountTotal),
    taxTotal: m(s.taxTotal),
    total: m(s.total),
    paidTotal: m(s.paidTotal),
    owed: owed.toFixed(4),
    createdById: s.createdById,
    note: s.note,
    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidReason: s.voidReason,
    lines: s.saleLines.map((l) => ({
      id: l.id,
      product: l.product,
      unit: { id: l.productUnit.id, name: l.productUnit.name, factor: q(l.productUnit.factorToBase) },
      quantity: q(l.quantity),
      quantityBase: q(l.quantityBase),
      unitPrice: m(l.unitPrice),
      discount: m(l.discount),
      tax: m(l.taxAmount),
      lineTotal: m(l.lineTotal),
      allocations: l.saleLineAllocations.map((a) => ({ id: a.id, supplyLocation: a.supplyLocation, qtyBase: q(a.qtyBase), qtyReleased: q(a.qtyReleased), remaining: D(a.qtyBase.toString()).minus(D(a.qtyReleased.toString())).toFixed() })),
    })),
    payments: s.paymentAllocations.map((a) => ({
      id: a.payment.id,
      number: a.payment.number,
      method: a.payment.method,
      account: a.payment.financialAccount.name,
      amount: m(a.amount),
      paidAt: a.payment.paidAt.toISOString(),
      status: a.payment.status,
    })),
    releases: s.saleReleases.map((r) => ({ id: r.id, location: r.location, releasedAt: r.releasedAt.toISOString(), note: r.note })),
  };
}

/** Which sales this person may see. */
function visibility(auth: AuthContext): Prisma.SaleWhereInput | null {
  const scope = scopeFor(auth, 'sales.view');
  if (scope === 'company') return {};
  if (scope === 'location') return { locationId: { in: auth.locationIds } };
  if (scope === 'own') return { createdById: auth.userId };
  return null;
}

async function loadDetail(tx: Tx, auth: AuthContext, id: string) {
  const vis = visibility(auth);
  if (!vis) throw forbidden();
  const s = await tx.sale.findFirst({ where: { id, companyId: auth.companyId, ...vis }, include: detailInclude });
  if (!s) throw notFound('Sale not found');
  return { sale: present(s) };
}
export const getSale = (auth: AuthContext, id: string) => withTenant(auth, (tx) => loadDetail(tx, auth, id));

export async function listSales(auth: AuthContext, f: SaleListQuery) {
  const vis = visibility(auth);
  if (!vis) throw forbidden();
  return withTenant(auth, async (tx) => {
    const where: Prisma.SaleWhereInput = {
      companyId: auth.companyId,
      ...vis,
      ...(f.status ? { status: f.status } : {}),
      ...(f.paymentStatus ? { paymentStatus: f.paymentStatus } : {}),
      ...(f.fulfillmentStatus ? { fulfillmentStatus: f.fulfillmentStatus } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.search ? { number: { contains: f.search, mode: 'insensitive' } } : {}),
      ...(f.from || f.to ? { soldAt: { ...(f.from ? { gte: toDateOnly(f.from) } : {}), ...(f.to ? { lt: new Date(toDateOnly(f.to).getTime() + 86_400_000) } : {}) } } : {}),
    };
    if (f.locationId) where.AND = [{ locationId: f.locationId }];
    const rows = await tx.sale.findMany({
      where,
      include: { location: { select: { id: true, name: true, code: true } }, customer: { select: { id: true, code: true, name: true } } },
      orderBy: [{ soldAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(f),
    });
    const page = toPage(rows, f.limit);
    return {
      items: page.items.map((s) => ({
        id: s.id, number: s.number, status: s.status, type: s.type, paymentStatus: s.paymentStatus, fulfillmentStatus: s.fulfillmentStatus,
        location: s.location, customer: s.customer, soldAt: s.soldAt.toISOString(), total: m(s.total), paidTotal: m(s.paidTotal),
      })),
      nextCursor: page.nextCursor,
    };
  });
}

/** The cash drawer(s) of this place and the bank accounts: where a seller may put money taken now. No balances shown. */
export async function paymentAccounts(auth: AuthContext, locationId: string) {
  assertSellsAt(auth, locationId);
  return withTenant(auth, async (tx) => {
    const rows = await tx.financialAccount.findMany({
      where: { companyId: auth.companyId, status: 'ACTIVE', OR: [{ type: 'BANK' }, { type: 'CASH', locationId }] },
      select: { id: true, name: true, type: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
    return { accounts: rows };
  });
}

// ───────────────────────── making a sale ─────────────────────────

export async function createSale(auth: AuthContext, input: CreateSaleInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const p = await prepare(tx, auth, input, false);
    const t = totalsOf(p.lines);

    // Lock every stock row we will touch (always in the same order), then check there is enough and the price is allowed.
    const bal = new Map<string, { id: string; onHand: string; committed: string; avgCost: string }>();
    for (const pr of pairsOf(p.lines)) bal.set(`${pr.locationId}:${pr.productId}`, await lockBalance(tx, companyId, pr.locationId, pr.productId));
    for (const l of p.lines) {
      for (const pt of l.parts) {
        const b = bal.get(`${pt.locationId}:${l.productId}`)!;
        const available = D(b.onHand).minus(D(b.committed));
        if (pt.qtyBase.gt(available)) throw insufficientStock(l.productName, l.baseUnit, pt.locationName, available, pt.qtyBase);
      }
      const cost = worstCost(l, bal);
      if (auth.role !== 'ADMIN' && cost.gt(0) && l.unitPrice!.lt(cost.times(l.factor))) {
        throw badRequest(`The price for "${l.productName}" is below cost. Ask the Admin to approve it.`);
      }
    }

    // Money taken now.
    const accounts = new Map((await tx.financialAccount.findMany({ where: { companyId, id: { in: input.payments.map((x) => x.financialAccountId) } } })).map((a) => [a.id, a]));
    for (const pay of input.payments) {
      const a = accounts.get(pay.financialAccountId);
      if (!a) throw notFound('Cash or bank account not found');
      if (a.status !== 'ACTIVE') throw badRequest(`"${a.name}" is switched off`);
      if (a.type === 'CASH' && a.locationId !== input.locationId && auth.role !== 'ADMIN') throw forbidden('That cash drawer belongs to another place');
    }
    const paid = sum(input.payments.map((x) => D(x.amount)));
    if (paid.gt(t.total)) throw badRequest(`The payment (${paid.toFixed(2)}) is more than the total (${t.total.toFixed(2)})`);
    const unpaid = t.total.minus(paid);

    // Whatever is not paid is credit: a named customer with a credit limit, kept within it.
    if (unpaid.gt(0)) {
      if (!p.customer) throw badRequest('Choose a customer to sell on credit, or take the full payment now');
      if (p.customer.creditLimit === null) throw badRequest(`"${p.customer.name}" cannot buy on credit. Take the full payment now, or ask the Admin to set a credit limit.`);
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${p.customer.id}::uuid FOR UPDATE`;
      const owes = D((await customerBalances(tx, companyId, [p.customer.id])).get(p.customer.id)!);
      const limit = D(p.customer.creditLimit.toString());
      if (owes.plus(unpaid).gt(limit)) {
        throw new AppError(409, 'CREDIT_LIMIT', `Credit limit exceeded: ${p.customer.name} owes ${owes.toFixed(2)}, this sale adds ${unpaid.toFixed(2)}, and the limit is ${limit.toFixed(2)}`);
      }
    }
    const status = paid.isZero() && t.total.gt(0) ? 'UNPAID' : paid.gte(t.total) ? 'PAID' : 'PARTIAL';
    const now = new Date();
    const dueDate = unpaid.gt(0) ? (input.dueDate ? toDateOnly(input.dueDate) : new Date(todayUtc().getTime() + (p.customer?.paymentTermsDays ?? 0) * 86_400_000)) : null;

    const number = await nextDocumentNumber(tx, companyId, 'SALE', { prefix: 'INV' });
    const sale = await tx.sale.create({
      data: {
        companyId, number, locationId: input.locationId, customerId: p.customer?.id ?? null, status: 'POSTED', type: p.type, paymentStatus: status,
        subtotal: t.subtotal.toString(), discountTotal: t.discountTotal.toString(), taxTotal: t.taxTotal.toString(), total: t.total.toString(), paidTotal: paid.toString(),
        soldAt: now, dueDate, createdById: auth.userId, note: input.note ?? null,
      },
      select: { id: true },
    });

    const allocs: { id: string; line: PLine; part: Part }[] = [];
    for (const l of p.lines) {
      const line = await tx.saleLine.create({
        data: {
          companyId, saleId: sale.id, productId: l.productId, productUnitId: l.unitId, quantity: l.quantity.toString(), quantityBase: l.baseQty.toString(),
          unitPrice: l.unitPrice!.toString(), discount: l.discount.toString(), taxAmount: l.tax.toString(), lineTotal: l.lineTotal.toString(),
        },
        select: { id: true },
      });
      for (const pt of l.parts) {
        const a = await tx.saleLineAllocation.create({ data: { companyId, saleLineId: line.id, supplyLocationId: pt.locationId, qtyBase: pt.qtyBase.toString() }, select: { id: true } });
        allocs.push({ id: a.id, line: l, part: pt });
      }
    }

    await postJournal(tx, { companyId, userId: auth.userId, draft: posting.sale({ locationId: input.locationId, customerId: p.customer?.id ?? null, netRevenue: t.net, tax: t.taxTotal }), entryDate: todayUtc(), sourceId: sale.id, event: 'sale' });

    for (const pay of input.payments) {
      const a = accounts.get(pay.financialAccountId)!;
      const payment = await tx.payment.create({
        data: {
          companyId, number: await nextDocumentNumber(tx, companyId, 'PAY', { prefix: 'PM' }), partyType: 'CUSTOMER', customerId: p.customer?.id ?? null, financialAccountId: a.id,
          method: a.type === 'CASH' ? 'CASH' : 'BANK_TRANSFER', amount: pay.amount, paidAt: now, status: 'POSTED', createdById: auth.userId, note: `Paid at sale ${number}`,
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({ data: { companyId, paymentId: payment.id, saleId: sale.id, amount: pay.amount, createdById: auth.userId } });
      await postJournal(tx, { companyId, userId: auth.userId, draft: posting.customerPayment({ customerId: p.customer?.id ?? null, financialAccountId: a.ledgerAccountId, amount: pay.amount }), entryDate: todayUtc(), sourceId: payment.id, event: 'payment' });
    }

    // Goods the selling place hands over now leave its stock now (and cost of goods sold is booked); the rest is reserved elsewhere.
    let released = ZERO;
    const here = allocs.filter((a) => a.part.local);
    if (here.length > 0) {
      const rel = await tx.saleRelease.create({ data: { companyId, saleId: sale.id, locationId: input.locationId, releasedById: auth.userId, note: 'Handed over at the sale' }, select: { id: true } });
      let cost = ZERO;
      for (const a of here) {
        const r = await postStockMovement(tx, { companyId, userId: auth.userId, locationId: input.locationId, productId: a.line.productId, type: 'SALE_RELEASE', quantity: a.part.qtyBase.neg(), refType: 'SALE', refId: sale.id, reason: `Sale ${number}` });
        cost = cost.plus(r.totalCost.abs());
        await tx.saleLineAllocation.update({ where: { id: a.id }, data: { qtyReleased: a.part.qtyBase.toString() } });
        await tx.saleReleaseLine.create({ data: { companyId, releaseId: rel.id, allocationId: a.id, qtyBase: a.part.qtyBase.toString() } });
        released = released.plus(a.part.qtyBase);
      }
      if (cost.gt(0)) await postJournal(tx, { companyId, userId: auth.userId, draft: posting.saleRelease({ sellingLocationId: input.locationId, supplyLocationId: input.locationId, cost }), entryDate: todayUtc(), sourceId: rel.id, event: 'release' });
    }
    for (const a of allocs.filter((x) => !x.part.local)) {
      const b = bal.get(`${a.part.locationId}:${a.line.productId}`)!;
      await tx.stockBalance.update({ where: { id: b.id }, data: { committed: { increment: a.part.qtyBase.toString() } } });
    }
    const totalBase = sum(allocs.map((a) => a.part.qtyBase));
    await tx.sale.update({ where: { id: sale.id }, data: { fulfillmentStatus: released.gte(totalBase) ? 'COMPLETE' : released.isZero() ? 'PENDING' : 'PARTIAL' } });

    await writeAudit(tx, { companyId, userId: auth.userId, action: 'sale.created', entityType: 'sale', entityId: sale.id, after: { number, total: t.total.toFixed(2), paid: paid.toFixed(2) }, ip });
    return loadDetail(tx, auth, sale.id);
  });
}

// ───────────────────────── releasing goods supplied by another place ─────────────────────────

/** Goods waiting to be handed over at the places this person works at. */
export async function pendingReleases(auth: AuthContext, locationId?: string) {
  const scope = scopeFor(auth, 'stock.release');
  if (!scope) throw forbidden();
  return withTenant(auth, async (tx) => {
    const where: Prisma.SaleLineAllocationWhereInput = {
      companyId: auth.companyId,
      ...(scope === 'company' ? {} : { supplyLocationId: { in: auth.locationIds } }),
      ...(locationId ? { supplyLocationId: locationId } : {}),
      saleLine: { sale: { status: 'POSTED' } },
    };
    const rows = await tx.saleLineAllocation.findMany({
      where,
      include: {
        supplyLocation: { select: { id: true, name: true } },
        saleLine: { include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } }, productUnit: { select: { name: true, factorToBase: true } }, sale: { select: { id: true, number: true, soldAt: true, location: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } } } } } },
      },
      orderBy: [{ saleLine: { sale: { soldAt: 'asc' } } }, { id: 'asc' }],
      take: 300,
    });
    const open = rows.filter((a) => D(a.qtyBase.toString()).gt(D(a.qtyReleased.toString())));
    return {
      items: open.map((a) => ({
        allocationId: a.id,
        supplyLocation: a.supplyLocation,
        sale: { id: a.saleLine.sale.id, number: a.saleLine.sale.number, soldAt: a.saleLine.sale.soldAt.toISOString(), location: a.saleLine.sale.location, customer: a.saleLine.sale.customer },
        product: a.saleLine.product,
        qtyBase: q(a.qtyBase),
        qtyReleased: q(a.qtyReleased),
        remaining: D(a.qtyBase.toString()).minus(D(a.qtyReleased.toString())).toFixed(),
      })),
    };
  });
}

/** The supplying place hands the goods over: its stock goes down now, the reservation ends, and cost of goods sold is booked. */
export async function releaseSale(auth: AuthContext, saleId: string, input: ReleaseInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, include: { saleLines: { include: { product: { select: { name: true } }, saleLineAllocations: true } } } });
    if (!sale) throw notFound('Sale not found');
    if (sale.status !== 'POSTED') throw conflict('This sale was voided, so nothing can be released');

    type A = { id: string; productId: string; productName: string; supplyLocationId: string; remaining: Decimal };
    const all: A[] = sale.saleLines.flatMap((l) => l.saleLineAllocations.map((a) => ({ id: a.id, productId: l.productId, productName: l.product.name, supplyLocationId: a.supplyLocationId, remaining: D(a.qtyBase.toString()).minus(D(a.qtyReleased.toString())) })));
    const mayAt = (loc: string) => can(auth, 'stock.release', { locationId: loc });

    let todo: { a: A; qty: Decimal }[];
    if (input.allocations) {
      todo = input.allocations.map((x) => {
        const a = all.find((y) => y.id === x.allocationId);
        if (!a) throw badRequest('That item is not part of this sale');
        if (!mayAt(a.supplyLocationId)) throw forbidden('Only the supplying place can release these goods');
        const qty = D(x.quantity);
        if (qty.gt(a.remaining)) throw badRequest(`${a.productName}: only ${a.remaining.toFixed()} is still waiting to be released`);
        return { a, qty };
      });
      if (new Set(todo.map((x) => x.a.id)).size !== todo.length) throw badRequest('The same item appears twice');
    } else {
      todo = all.filter((a) => a.remaining.gt(0) && mayAt(a.supplyLocationId)).map((a) => ({ a, qty: a.remaining }));
      if (todo.length === 0) throw badRequest(all.some((a) => a.remaining.gt(0)) ? 'Nothing here is waiting for your place to release' : 'Everything on this sale has already been released');
    }
    todo.sort((x, y) => `${x.a.supplyLocationId}:${x.a.productId}`.localeCompare(`${y.a.supplyLocationId}:${y.a.productId}`));

    const byLocation = new Map<string, { releaseId: string; cost: Decimal }>();
    for (const { a, qty } of todo) {
      const b = await lockBalance(tx, companyId, a.supplyLocationId, a.productId);
      if (D(b.committed).lt(qty)) throw conflict(`${a.productName}: the reservation no longer covers this quantity`);
      await tx.stockBalance.update({ where: { id: b.id }, data: { committed: { decrement: qty.toString() } } });
      let g = byLocation.get(a.supplyLocationId);
      if (!g) {
        const rel = await tx.saleRelease.create({ data: { companyId, saleId, locationId: a.supplyLocationId, releasedById: auth.userId, note: input.note ?? null }, select: { id: true } });
        g = { releaseId: rel.id, cost: ZERO };
        byLocation.set(a.supplyLocationId, g);
      }
      const r = await postStockMovement(tx, { companyId, userId: auth.userId, locationId: a.supplyLocationId, productId: a.productId, type: 'SALE_RELEASE', quantity: qty.neg(), refType: 'SALE', refId: saleId, reason: `Released for sale ${sale.number}` });
      g.cost = g.cost.plus(r.totalCost.abs());
      await tx.saleLineAllocation.update({ where: { id: a.id }, data: { qtyReleased: { increment: qty.toString() } } });
      await tx.saleReleaseLine.create({ data: { companyId, releaseId: g.releaseId, allocationId: a.id, qtyBase: qty.toString() } });
    }
    for (const [supplyLocationId, g] of byLocation) {
      if (g.cost.gt(0)) await postJournal(tx, { companyId, userId: auth.userId, draft: posting.saleRelease({ sellingLocationId: sale.locationId, supplyLocationId, cost: g.cost }), entryDate: todayUtc(), sourceId: g.releaseId, event: 'release' });
    }
    const left = sum(all.map((a) => a.remaining)).minus(sum(todo.map((x) => x.qty)));
    const totalBase = sum(sale.saleLines.flatMap((l) => l.saleLineAllocations.map((a) => D(a.qtyBase.toString()))));
    await tx.sale.update({ where: { id: saleId }, data: { fulfillmentStatus: left.isZero() ? 'COMPLETE' : left.gte(totalBase) ? 'PENDING' : 'PARTIAL' } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'sale.released', entityType: 'sale', entityId: saleId, after: { number: sale.number, items: todo.length }, ip });
    // The person releasing may not be allowed to browse sales, so show the result directly instead of through the visibility rules.
    return { sale: present(await tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: detailInclude })) };
  });
}

// ───────────────────────── voiding ─────────────────────────

/**
 * Cancels a posted sale. Goods that already left go back into stock at the cost they left at (so the average never
 * jumps), goods still reserved are freed, and the sale and its payments are reversed in the books. The sale stays on
 * record as VOIDED. Not allowed once a return has been made against it.
 */
export async function voidSale(auth: AuthContext, saleId: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    /* const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, include: { saleLines: { include: { saleLineAllocations: true } }, saleReleases: { select: { id: true } }, paymentAllocations: true } }); */
    // Lock the sale first (a payment on it locks the same row), so a payment and a void can never cross.
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
    const sale = await tx.sale.findFirst({ where: { id: saleId, companyId }, include: { saleLines: { include: { saleLineAllocations: true } }, saleReleases: { select: { id: true } }, paymentAllocations: { include: { payment: { select: { status: true } } } } } });
    if (!sale || !visibility(auth)) throw notFound('Sale not found');
    if (!can(auth, 'sales.void', { locationId: sale.locationId })) throw forbidden('Only a Manager or the Admin can void a sale');
    if (sale.status !== 'POSTED') throw conflict('This sale is already voided');
    if ((await tx.saleReturn.count({ where: { saleId } })) > 0) throw conflict('Goods were already returned against this sale, so it cannot be voided');

    /* const paymentIds = [...new Set(sale.paymentAllocations.map((a) => a.paymentId))]; */
    // Payments already cancelled on their own have nothing left to reverse.
    const paymentIds = [...new Set(sale.paymentAllocations.filter((a) => a.payment.status === 'POSTED').map((a) => a.paymentId))];
    if (paymentIds.length > 0 && (await tx.paymentAllocation.count({ where: { paymentId: { in: paymentIds }, OR: [{ saleId: { not: saleId } }, { purchaseReceiptId: { not: null } }] } })) > 0) {
      throw conflict('A payment on this sale also covers other documents, so it cannot be voided here');
    }

    // Goods that already left come back at the cost they left at.
    const moves = await tx.stockMovement.findMany({ where: { companyId, refType: 'SALE', refId: saleId, type: 'SALE_RELEASE' }, orderBy: { seq: 'asc' } });
    for (const mv of [...moves].sort((a, b) => `${a.locationId}:${a.productId}`.localeCompare(`${b.locationId}:${b.productId}`))) {
      await postStockMovement(tx, { companyId, userId: auth.userId, locationId: mv.locationId, productId: mv.productId, type: 'RETURN_IN', quantity: D(mv.quantity.toString()).abs(), unitCost: mv.unitCost.toString(), refType: 'SALE_VOID', refId: saleId, reason: `Voided sale ${sale.number}` });
    }
    // Goods still reserved at another place are freed.
    for (const a of sale.saleLines.flatMap((l) => l.saleLineAllocations.map((x) => ({ ...x, productId: l.productId })))) {
      const left = D(a.qtyBase.toString()).minus(D(a.qtyReleased.toString()));
      if (left.lte(0)) continue;
      const b = await lockBalance(tx, companyId, a.supplyLocationId, a.productId);
      await tx.stockBalance.update({ where: { id: b.id }, data: { committed: { decrement: left.toString() } } });
    }
    // The books: the sale, its payments and every release.
    const sourceIds = [saleId, ...paymentIds, ...sale.saleReleases.map((r) => r.id)];
    const entries = await tx.journalEntry.findMany({ where: { companyId, sourceId: { in: sourceIds }, reversalOfId: null, reversedBy: { is: null } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    for (const e of entries) await reverseJournal(tx, { companyId, userId: auth.userId }, e.id, { date: todayUtc(), reason: `Voided sale ${sale.number}: ${reason}` });
    if (paymentIds.length > 0) await tx.payment.updateMany({ where: { id: { in: paymentIds } }, data: { status: 'VOIDED' } });
    await tx.sale.update({ where: { id: saleId }, data: { status: 'VOIDED', voidedAt: new Date(), voidedById: auth.userId, voidReason: reason } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'sale.voided', entityType: 'sale', entityId: saleId, after: { number: sale.number, reason }, ip });
    return loadDetail(tx, auth, saleId);
  });
}