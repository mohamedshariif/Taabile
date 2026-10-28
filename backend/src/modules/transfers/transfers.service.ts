import type { Prisma, Transfer } from '@prisma/client';
import { postJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import { postStockMovement } from '../../inventory/stock.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D, storeMoney, ZERO } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { can, scopeFor, type Permission } from '../auth/permissions.js';
import { toBaseTerms } from '../stock/stock.service.js';
import type { CreateTransferInput, DispatchInput, ReceiveInput, TransferListQuery } from './transfers.schemas.js';

// Moving goods between two places, in steps:
//   REQUESTED -> (approve) -> APPROVED -> (dispatch) -> IN_TRANSIT -> (receive) -> RECEIVED
//                                                                           \-> DISCREPANCY -> (close, write off) -> CLOSED
//   REQUESTED or APPROVED can also be REJECTED / CANCELLED.
// Dispatch takes the goods out of the sending place at its average cost; receiving brings them in at that same
// cost. In between, their value sits in the "Goods in transit" account, so it is never lost from the books.
// Who: the SENDING place requests/approves/dispatches (stock.transfer); the RECEIVING place receives (stock.receive).

const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

const detailInclude = {
  fromLocation: { select: { id: true, name: true, code: true } },
  toLocation: { select: { id: true, name: true, code: true } },
  transferLines: { orderBy: [{ product: { name: 'asc' as const } }, { id: 'asc' as const }], include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } } } },
} satisfies Prisma.TransferInclude;
type Detail = Prisma.TransferGetPayload<{ include: typeof detailInclude }>;

const q = (v: { toString(): string }) => D(v.toString()).toFixed();

function present(t: Detail) {
  return {
    id: t.id,
    number: t.number,
    status: t.status,
    from: t.fromLocation,
    to: t.toLocation,
    requestedAt: t.requestedAt.toISOString(),
    dispatchedAt: t.dispatchedAt?.toISOString() ?? null,
    receivedAt: t.receivedAt?.toISOString() ?? null,
    note: t.note,
    lines: t.transferLines.map((l) => ({
      id: l.id,
      product: l.product,
      qtyRequested: q(l.qtyRequested),
      qtyDispatched: q(l.qtyDispatched),
      qtyReceived: q(l.qtyReceived),
      discrepancyNote: l.discrepancyNote,
    })),
  };
}

const atAny = (auth: AuthContext, perm: Permission, t: Pick<Transfer, 'fromLocationId' | 'toLocationId'>) =>
  can(auth, perm, { locationId: t.fromLocationId }) || can(auth, perm, { locationId: t.toLocationId });

async function load(tx: Tx, auth: AuthContext, id: string) {
  const t = await tx.transfer.findFirst({ where: { id, companyId: auth.companyId }, include: { transferLines: true } });
  if (!t) throw notFound('Transfer not found');
  return t;
}
const reload = async (tx: Tx, id: string) => ({ transfer: present(await tx.transfer.findUniqueOrThrow({ where: { id }, include: detailInclude })) });

// ───────────────────────── reading ─────────────────────────

export async function listTransfers(auth: AuthContext, f: TransferListQuery) {
  const scope = scopeFor(auth, 'stock.view');
  const own = scope === 'company' ? null : auth.locationIds;
  return withTenant(auth, async (tx) => {
    const and: Prisma.TransferWhereInput[] = [];
    if (own) and.push({ OR: [{ fromLocationId: { in: own } }, { toLocationId: { in: own } }] });
    if (f.locationId) and.push({ OR: [{ fromLocationId: f.locationId }, { toLocationId: f.locationId }] });
    const rows = await tx.transfer.findMany({
      where: { companyId: auth.companyId, ...(f.status ? { status: f.status } : {}), ...(and.length ? { AND: and } : {}) },
      include: { fromLocation: { select: { id: true, name: true, code: true } }, toLocation: { select: { id: true, name: true, code: true } }, _count: { select: { transferLines: true } } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(f),
    });
    const page = toPage(rows, f.limit);
    return {
      items: page.items.map((t) => ({ id: t.id, number: t.number, status: t.status, from: t.fromLocation, to: t.toLocation, requestedAt: t.requestedAt.toISOString(), products: t._count.transferLines })),
      nextCursor: page.nextCursor,
    };
  });
}

export async function getTransfer(auth: AuthContext, id: string) {
  const scope = scopeFor(auth, 'stock.view');
  return withTenant(auth, async (tx) => {
    const t = await tx.transfer.findFirst({ where: { id, companyId: auth.companyId }, include: detailInclude });
    if (!t || (scope !== 'company' && !auth.locationIds.includes(t.fromLocation.id) && !auth.locationIds.includes(t.toLocation.id))) throw notFound('Transfer not found');
    return { transfer: present(t) };
  });
}

// ───────────────────────── request / approve / reject / cancel ─────────────────────────

export async function createTransfer(auth: AuthContext, input: CreateTransferInput, ip?: string) {
  if (!atAny(auth, 'stock.transfer', input)) throw forbidden('You can only request transfers for your own locations');
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const locs = await tx.location.findMany({ where: { companyId, id: { in: [input.fromLocationId, input.toLocationId] } }, select: { id: true, name: true, status: true } });
    if (locs.length !== 2) throw notFound('Location not found');
    for (const l of locs) if (l.status !== 'ACTIVE') throw badRequest(`"${l.name}" is switched off`);

    const lines = [];
    for (const l of input.lines) {
      const t = await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.quantity });
      if (t.product.status !== 'ACTIVE') throw badRequest(`"${t.product.name}" is switched off`);
      lines.push({ companyId, productId: l.productId, qtyRequested: t.baseQty.toString() });
    }
    const number = await nextDocumentNumber(tx, companyId, 'TRF', { prefix: 'TR' });
    const created = await tx.transfer.create({
      data: { companyId, number, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, requestedById: auth.userId, note: input.note ?? null, transferLines: { create: lines } },
      select: { id: true },
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'transfer.requested', entityType: 'transfer', entityId: created.id, after: { number, products: lines.length }, ip });
    return reload(tx, created.id);
  });
}

export async function approveTransfer(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const t = await load(tx, auth, id);
    if (!can(auth, 'stock.transfer', { locationId: t.fromLocationId })) throw forbidden('Only the sending place can approve a transfer');
    if (t.status !== 'REQUESTED') throw conflict(`This transfer is already ${t.status.toLowerCase().replace('_', ' ')}`);
    await tx.transfer.update({ where: { id }, data: { status: 'APPROVED', approvedById: auth.userId } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'transfer.approved', entityType: 'transfer', entityId: id, after: { number: t.number }, ip });
    return reload(tx, id);
  });
}

export async function rejectTransfer(auth: AuthContext, id: string, reason: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const t = await load(tx, auth, id);
    if (!can(auth, 'stock.transfer', { locationId: t.fromLocationId })) throw forbidden('Only the sending place can reject a transfer');
    if (t.status !== 'REQUESTED') throw conflict(`This transfer is already ${t.status.toLowerCase().replace('_', ' ')}`);
    await tx.transfer.update({ where: { id }, data: { status: 'REJECTED', note: [t.note, `Rejected: ${reason}`].filter(Boolean).join('\n') } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'transfer.rejected', entityType: 'transfer', entityId: id, after: { number: t.number, reason }, ip });
    return reload(tx, id);
  });
}

export async function cancelTransfer(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const t = await load(tx, auth, id);
    if (!atAny(auth, 'stock.transfer', t)) throw forbidden('You can only cancel transfers of your own locations');
    if (!['REQUESTED', 'APPROVED'].includes(t.status)) throw conflict('Only a transfer that has not been sent yet can be cancelled');
    await tx.transfer.update({ where: { id }, data: { status: 'CANCELLED' } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'transfer.cancelled', entityType: 'transfer', entityId: id, after: { number: t.number }, ip });
    return reload(tx, id);
  });
}

// ───────────────────────── dispatch ─────────────────────────

/** The sending place hands the goods over: stock leaves at its average cost and its value moves to "Goods in transit". */
export async function dispatchTransfer(auth: AuthContext, id: string, input: DispatchInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const t = await load(tx, auth, id);
    if (!can(auth, 'stock.transfer', { locationId: t.fromLocationId })) throw forbidden('Only the sending place can send a transfer');
    if (!['REQUESTED', 'APPROVED'].includes(t.status)) throw conflict(`This transfer is already ${t.status.toLowerCase().replace('_', ' ')}`);

    // What to send per product, in base units (default: everything that was asked for).
    const send = new Map<string, ReturnType<typeof D>>(t.transferLines.map((l) => [l.productId, D(l.qtyRequested.toString())]));
    for (const l of input.lines ?? []) {
      const line = t.transferLines.find((x) => x.productId === l.productId);
      if (!line) throw badRequest('That product is not part of this transfer');
      const base = D(l.quantity).isZero() ? ZERO : (await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.quantity })).baseQty;
      if (base.gt(D(line.qtyRequested.toString()))) throw badRequest('You cannot send more than was requested');
      send.set(l.productId, base);
    }
    if (input.lines) for (const l of t.transferLines) if (!input.lines.some((x) => x.productId === l.productId)) send.set(l.productId, ZERO);
    if ([...send.values()].every((v) => v.isZero())) throw badRequest('Nothing to send: every quantity is zero');

    let cost = ZERO;
    for (const l of [...t.transferLines].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const qty = send.get(l.productId)!;
      if (qty.isZero()) continue;
      const r = await postStockMovement(tx, { companyId, userId: auth.userId, locationId: t.fromLocationId, productId: l.productId, type: 'TRANSFER_OUT', quantity: qty.neg(), refType: 'TRANSFER', refId: id, reason: `Sent ${t.number}` });
      cost = cost.plus(r.totalCost.abs());
      await tx.transferLine.update({ where: { id: l.id }, data: { qtyDispatched: qty.toString() } });
    }
    if (cost.gt(0)) await postJournal(tx, { companyId, userId: auth.userId, draft: posting.transferDispatch({ fromLocationId: t.fromLocationId, cost }), entryDate: today(), sourceId: id, event: 'dispatch' });
    await tx.transfer.update({ where: { id }, data: { status: 'IN_TRANSIT', approvedById: t.approvedById ?? auth.userId, dispatchedById: auth.userId, dispatchedAt: new Date() } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'transfer.dispatched', entityType: 'transfer', entityId: id, after: { number: t.number }, ip });
    return reload(tx, id);
  });
}

// ───────────────────────── receive ─────────────────────────

/** The receiving place counts what arrived. Short deliveries leave the transfer in DISCREPANCY until someone closes it. */
export async function receiveTransfer(auth: AuthContext, id: string, input: ReceiveInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const t = await load(tx, auth, id);
    if (!can(auth, 'stock.receive', { locationId: t.toLocationId })) throw forbidden('Only the receiving place can receive a transfer');
    if (t.status !== 'IN_TRANSIT') throw conflict('Only a transfer that is on its way can be received');

    const sent = t.transferLines.filter((l) => D(l.qtyDispatched.toString()).gt(0));
    const got = new Map<string, { qty: ReturnType<typeof D>; note?: string | undefined }>(sent.map((l) => [l.productId, { qty: D(l.qtyDispatched.toString()) }]));
    for (const l of input.lines ?? []) {
      const line = sent.find((x) => x.productId === l.productId);
      if (!line) throw badRequest('That product was not sent in this transfer');
      const base = D(l.quantity).isZero() ? ZERO : (await toBaseTerms(tx, companyId, { productId: l.productId, unitId: l.unitId, quantity: l.quantity })).baseQty;
      if (base.gt(D(line.qtyDispatched.toString()))) throw badRequest('You cannot receive more than was sent. Ask the sending place to correct it.');
      got.set(l.productId, { qty: base, note: l.note });
    }
    if (input.lines) for (const l of sent) if (!input.lines.some((x) => x.productId === l.productId)) got.set(l.productId, { qty: ZERO });

    let inCost = ZERO;
    let shortLines = 0;
    for (const l of [...sent].sort((a, b) => a.productId.localeCompare(b.productId))) {
      const g = got.get(l.productId)!;
      const dispatched = D(l.qtyDispatched.toString());
      const short = g.qty.lt(dispatched);
      if (short && !g.note) throw badRequest('Say what happened to the missing goods (a note is needed on every short line)');
      if (g.qty.gt(0)) {
        // They arrive at exactly the cost they left at.
        const out = await tx.stockMovement.findFirst({ where: { companyId, refType: 'TRANSFER', refId: id, productId: l.productId, type: 'TRANSFER_OUT' }, select: { unitCost: true } });
        const r = await postStockMovement(tx, { companyId, userId: auth.userId, locationId: t.toLocationId, productId: l.productId, type: 'TRANSFER_IN', quantity: g.qty, unitCost: out!.unitCost.toString(), refType: 'TRANSFER', refId: id, reason: `Received ${t.number}` });
        inCost = inCost.plus(r.totalCost);
      }
      if (short) shortLines++;
      await tx.transferLine.update({ where: { id: l.id }, data: { qtyReceived: g.qty.toString(), discrepancyNote: short ? g.note! : null } });
    }
    if (inCost.gt(0)) await postJournal(tx, { companyId, userId: auth.userId, draft: posting.transferReceive({ toLocationId: t.toLocationId, cost: inCost }), entryDate: today(), sourceId: id, event: 'receive' });
    await tx.transfer.update({ where: { id }, data: { status: shortLines > 0 ? 'DISCREPANCY' : 'RECEIVED', receivedById: auth.userId, receivedAt: new Date() } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: shortLines > 0 ? 'transfer.received_short' : 'transfer.received', entityType: 'transfer', entityId: id, after: { number: t.number, shortLines }, ip });
    return reload(tx, id);
  });
}

/** Writes off what never arrived (its value leaves "Goods in transit" as an inventory loss) and closes the transfer. */
export async function closeTransfer(auth: AuthContext, id: string, note: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const t = await load(tx, auth, id);
    if (!atAny(auth, 'stock.adjust_approve', t)) throw forbidden('Only a Manager or Admin of the sending or receiving place can close a transfer with missing goods');
    if (t.status !== 'DISCREPANCY') throw conflict('Only a transfer with missing goods can be closed this way');

    const sum = async (type: 'TRANSFER_OUT' | 'TRANSFER_IN') => {
      const rows = await tx.stockMovement.findMany({ where: { companyId, refType: 'TRANSFER', refId: id, type }, select: { totalCost: true } });
      return rows.reduce((s, r) => s.plus(D(r.totalCost.toString()).abs()), ZERO);
    };
    const lost = storeMoney((await sum('TRANSFER_OUT')).minus(await sum('TRANSFER_IN')));
    if (lost.gt(0)) await postJournal(tx, { companyId, userId: auth.userId, draft: posting.transferLoss({ cost: lost }), entryDate: today(), sourceId: id, event: 'loss' });
    await tx.transfer.update({ where: { id }, data: { status: 'CLOSED', note: [t.note, `Closed: ${note}`].filter(Boolean).join('\n') } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'transfer.closed', entityType: 'transfer', entityId: id, after: { number: t.number, writtenOff: lost.toFixed(4), note }, ip });
    return reload(tx, id);
  });
}