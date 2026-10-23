import type { Prisma, Supplier } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { supplierBalances } from '../../shared/balances.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { conflict, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { describeReferences, referencesTo } from '../../shared/references.js';
import type { CreateSupplierInput, SupplierListQuery, UpdateSupplierInput } from './suppliers.schemas.js';

// Rules in this file:
//  * A supplier is a company-wide record. Two suppliers cannot have the same name (ignoring capitals): that is almost always a duplicate.
//  * paymentTermsDays = how many days the supplier gives us to pay (used when purchases are recorded on credit).
//  * A supplier we owe money to (or who owes us) cannot be switched off until the balance is settled.
//  * A supplier that has ever been used (purchases, payments, expenses, accounting entries) can never be deleted, only switched off.

const present = (s: Supplier, balance: string) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  phone: s.phone,
  address: s.address,
  paymentTermsDays: s.paymentTermsDays,
  status: s.status,
  balance, // what we owe them right now
  createdAt: s.createdAt.toISOString(),
});

async function load(tx: Tx, companyId: string, id: string) {
  const s = await tx.supplier.findFirst({ where: { id, companyId } });
  if (!s) throw notFound('Supplier not found');
  return s;
}

async function detail(tx: Tx, companyId: string, id: string) {
  const s = await load(tx, companyId, id);
  return { supplier: present(s, (await supplierBalances(tx, companyId, [id])).get(id)!) };
}

async function assertNameFree(tx: Tx, companyId: string, name: string, exceptId?: string) {
  const other = await tx.supplier.findFirst({
    where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { code: true },
  });
  if (other) throw conflict(`A supplier called "${name}" already exists (${other.code})`);
}

async function assertCodeFree(tx: Tx, companyId: string, code: string, exceptId?: string) {
  const other = await tx.supplier.findUnique({ where: { companyId_code: { companyId, code } }, select: { id: true, name: true } });
  if (other && other.id !== exceptId) throw conflict(`The code ${code} is already used by "${other.name}"`);
}

async function generateCode(tx: Tx, companyId: string) {
  for (let i = 0; i < 20; i++) {
    const code = await nextDocumentNumber(tx, companyId, 'SUP', { prefix: 'S' });
    if (!(await tx.supplier.findUnique({ where: { companyId_code: { companyId, code } }, select: { id: true } }))) return code;
  }
  throw conflict('Could not make a free supplier code. Type one yourself.');
}

export async function listSuppliers(auth: AuthContext, q: SupplierListQuery) {
  return withTenant(auth, async (tx) => {
    const where: Prisma.SupplierWhereInput = {
      companyId: auth.companyId,
      ...(q.status !== 'ALL' ? { status: q.status } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search.replace(/[\s\-().]/g, '') || q.search } }] }
        : {}),
    };
    const rows = await tx.supplier.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(q) });
    const page = toPage(rows, q.limit);
    const bal = await supplierBalances(tx, auth.companyId, page.items.map((s) => s.id));
    return { items: page.items.map((s) => present(s, bal.get(s.id)!)), nextCursor: page.nextCursor };
  });
}

export const getSupplier = (auth: AuthContext, id: string) => withTenant(auth, (tx) => detail(tx, auth.companyId, id));

export async function createSupplier(auth: AuthContext, input: CreateSupplierInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await assertNameFree(tx, companyId, input.name);
    const code = input.code ?? (await generateCode(tx, companyId));
    await assertCodeFree(tx, companyId, code);
    const s = await tx.supplier.create({
      data: { companyId, code, name: input.name, phone: input.phone ?? null, address: input.address ?? null, paymentTermsDays: input.paymentTermsDays ?? 0 },
    });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'supplier.created', entityType: 'supplier', entityId: s.id, after: { code, name: s.name, paymentTermsDays: s.paymentTermsDays }, ip });
    return detail(tx, companyId, s.id);
  });
}

export async function updateSupplier(auth: AuthContext, id: string, input: UpdateSupplierInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const cur = await load(tx, companyId, id);

    const data: Prisma.SupplierUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = (k: string, from: unknown, to: unknown, set: () => void) => {
      if (String(from ?? '') === String(to ?? '')) return;
      before[k] = from ?? null;
      after[k] = to ?? null;
      set();
    };

    if (input.name !== undefined && input.name !== cur.name) {
      await assertNameFree(tx, companyId, input.name, id);
      change('name', cur.name, input.name, () => (data.name = input.name!));
    }
    if (input.code !== undefined && input.code !== cur.code) {
      await assertCodeFree(tx, companyId, input.code, id);
      change('code', cur.code, input.code, () => (data.code = input.code!));
    }
    if (input.phone !== undefined) change('phone', cur.phone, input.phone, () => (data.phone = input.phone ?? null));
    if (input.address !== undefined) change('address', cur.address, input.address, () => (data.address = input.address ?? null));
    if (input.paymentTermsDays !== undefined) change('paymentTermsDays', cur.paymentTermsDays, input.paymentTermsDays, () => (data.paymentTermsDays = input.paymentTermsDays!));
    if (input.status !== undefined && input.status !== cur.status) {
      if (input.status === 'INACTIVE') {
        const bal = D((await supplierBalances(tx, companyId, [id])).get(id)!);
        if (!bal.isZero()) throw conflict(`"${cur.name}" has an open balance of ${bal.toFixed(2)}. Settle it before switching this supplier off.`);
      }
      change('status', cur.status, input.status, () => (data.status = input.status!));
    }

    if (Object.keys(data).length > 0) {
      await tx.supplier.update({ where: { id }, data });
      await writeAudit(tx, { companyId, userId: auth.userId, action: 'supplier.updated', entityType: 'supplier', entityId: id, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue, ip });
    }
    return detail(tx, companyId, id);
  });
}

export async function deleteSupplier(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const s = await load(tx, companyId, id);
    const uses = await referencesTo(tx, 'suppliers', id);
    if (uses.length > 0) throw conflict(`"${s.name}" has been used (${describeReferences(uses)}), so it cannot be deleted. Switch it off instead.`);
    await tx.supplier.delete({ where: { id } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'supplier.deleted', entityType: 'supplier', entityId: id, before: { code: s.code, name: s.name, phone: s.phone }, ip });
    return { deleted: { id, code: s.code, name: s.name } };
  });
}