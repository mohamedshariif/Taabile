import type { Customer, Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { customerBalances } from '../../shared/balances.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { describeReferences, referencesTo } from '../../shared/references.js';
import { can } from '../auth/permissions.js';
import type { CreateCustomerInput, CustomerListQuery, UpdateCustomerInput } from './customers.schemas.js';

// Rules in this file:
//  * A customer is a company-wide record (any store can sell to them). Walk-in retail sales need no customer at all.
//  * creditLimit empty = this customer cannot buy on credit (cash only). A number = may owe up to that much.
//    Credit limit and payment terms are risk decisions, so they need the separate credit.manage permission.
//  * A customer who owes money (or is owed money) cannot be switched off until the balance is settled.
//  * A customer who has ever been used (sales, payments, accounting entries) can never be deleted, only switched off.

const present = (c: Customer & { priceList?: { id: string; name: string } | null }, balance: string) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  phone: c.phone,
  address: c.address,
  priceList: c.priceList ? { id: c.priceList.id, name: c.priceList.name } : null,
  creditLimit: c.creditLimit ? c.creditLimit.toFixed(4) : null,
  paymentTermsDays: c.paymentTermsDays,
  status: c.status,
  balance, // what they owe us right now
  createdAt: c.createdAt.toISOString(),
});

const include = { priceList: { select: { id: true, name: true } } } satisfies Prisma.CustomerInclude;

async function load(tx: Tx, companyId: string, id: string) {
  const c = await tx.customer.findFirst({ where: { id, companyId }, include });
  if (!c) throw notFound('Customer not found');
  return c;
}

async function detail(tx: Tx, companyId: string, id: string) {
  const c = await load(tx, companyId, id);
  const bal = await customerBalances(tx, companyId, [id]);
  return { customer: present(c, bal.get(id)!) };
}

async function assertPriceList(tx: Tx, companyId: string, id: string) {
  const l = await tx.priceList.findFirst({ where: { id, companyId }, select: { status: true } });
  if (!l) throw badRequest('That price list does not exist');
  if (l.status !== 'ACTIVE') throw badRequest('That price list is switched off');
}

async function assertPhoneFree(tx: Tx, companyId: string, phone: string, exceptId?: string) {
  const other = await tx.customer.findFirst({ where: { companyId, phone, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true, code: true } });
  if (other) throw conflict(`This phone number already belongs to "${other.name}" (${other.code})`);
}

async function assertCodeFree(tx: Tx, companyId: string, code: string, exceptId?: string) {
  const other = await tx.customer.findUnique({ where: { companyId_code: { companyId, code } }, select: { id: true, name: true } });
  if (other && other.id !== exceptId) throw conflict(`The code ${code} is already used by "${other.name}"`);
}

async function generateCode(tx: Tx, companyId: string) {
  for (let i = 0; i < 20; i++) {
    const code = await nextDocumentNumber(tx, companyId, 'CUS', { prefix: 'C' });
    if (!(await tx.customer.findUnique({ where: { companyId_code: { companyId, code } }, select: { id: true } }))) return code;
  }
  throw conflict('Could not make a free customer code. Type one yourself.');
}

const NEEDS_CREDIT = 'Only people allowed to manage credit can set a credit limit or payment terms';

export async function listCustomers(auth: AuthContext, q: CustomerListQuery) {
  return withTenant(auth, async (tx) => {
    const where: Prisma.CustomerWhereInput = {
      companyId: auth.companyId,
      ...(q.status !== 'ALL' ? { status: q.status } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search.replace(/[\s\-().]/g, '') || q.search } }] }
        : {}),
    };
    const rows = await tx.customer.findMany({ where, include, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(q) });
    const page = toPage(rows, q.limit);
    const bal = await customerBalances(tx, auth.companyId, page.items.map((c) => c.id));
    return { items: page.items.map((c) => present(c, bal.get(c.id)!)), nextCursor: page.nextCursor };
  });
}

export const getCustomer = (auth: AuthContext, id: string) => withTenant(auth, (tx) => detail(tx, auth.companyId, id));

export async function createCustomer(auth: AuthContext, input: CreateCustomerInput, ip?: string) {
  const wantsCredit = (input.creditLimit != null && !D(input.creditLimit).isZero()) || (input.paymentTermsDays ?? 0) !== 0;
  if (wantsCredit && !can(auth, 'credit.manage')) throw forbidden(NEEDS_CREDIT);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    if (input.priceListId) await assertPriceList(tx, companyId, input.priceListId);
    if (input.phone) await assertPhoneFree(tx, companyId, input.phone);
    const code = input.code ?? (await generateCode(tx, companyId));
    await assertCodeFree(tx, companyId, code);
    const c = await tx.customer.create({
      data: {
        companyId,
        code,
        name: input.name,
        phone: input.phone ?? null,
        address: input.address ?? null,
        priceListId: input.priceListId ?? null,
        creditLimit: input.creditLimit ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 0,
      },
    });
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: c.id,
      after: { code, name: c.name, creditLimit: input.creditLimit ?? null, paymentTermsDays: c.paymentTermsDays },
      ip,
    });
    return detail(tx, companyId, c.id);
  });
}

export async function updateCustomer(auth: AuthContext, id: string, input: UpdateCustomerInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    // Serialise changes to the same customer (released when the transaction ends).
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const cur = await load(tx, companyId, id);

    const data: Prisma.CustomerUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = (k: string, from: unknown, to: unknown, set: () => void) => {
      if (String(from ?? '') === String(to ?? '')) return;
      before[k] = from ?? null;
      after[k] = to ?? null;
      set();
    };

    if (input.name !== undefined) change('name', cur.name, input.name, () => (data.name = input.name!));
    if (input.code !== undefined && input.code !== cur.code) {
      await assertCodeFree(tx, companyId, input.code, id);
      change('code', cur.code, input.code, () => (data.code = input.code!));
    }
    if (input.phone !== undefined && (input.phone ?? null) !== cur.phone) {
      if (input.phone) await assertPhoneFree(tx, companyId, input.phone, id);
      change('phone', cur.phone, input.phone, () => (data.phone = input.phone ?? null));
    }
    if (input.address !== undefined) change('address', cur.address, input.address, () => (data.address = input.address ?? null));
    if (input.priceListId !== undefined && (input.priceListId ?? null) !== cur.priceListId) {
      if (input.priceListId) await assertPriceList(tx, companyId, input.priceListId);
      change('priceListId', cur.priceListId, input.priceListId, () => (data.priceListId = input.priceListId ?? null));
    }
    if (input.creditLimit !== undefined) {
      const was = cur.creditLimit ? cur.creditLimit.toFixed(4) : null;
      const now = input.creditLimit === null ? null : D(input.creditLimit).toFixed(4);
      if (was !== now) {
        if (!can(auth, 'credit.manage')) throw forbidden(NEEDS_CREDIT);
        change('creditLimit', was, now, () => (data.creditLimit = now));
      }
    }
    if (input.paymentTermsDays !== undefined && input.paymentTermsDays !== cur.paymentTermsDays) {
      if (!can(auth, 'credit.manage')) throw forbidden(NEEDS_CREDIT);
      change('paymentTermsDays', cur.paymentTermsDays, input.paymentTermsDays, () => (data.paymentTermsDays = input.paymentTermsDays!));
    }
    if (input.status !== undefined && input.status !== cur.status) {
      if (input.status === 'INACTIVE') {
        const bal = D((await customerBalances(tx, companyId, [id])).get(id)!);
        if (!bal.isZero()) {
          throw conflict(`"${cur.name}" has an open balance of ${bal.toFixed(2)}. Settle it before switching this customer off.`);
        }
      }
      change('status', cur.status, input.status, () => (data.status = input.status!));
    }

    if (Object.keys(data).length > 0) {
      await tx.customer.update({ where: { id }, data });
      await writeAudit(tx, { companyId, userId: auth.userId, action: 'customer.updated', entityType: 'customer', entityId: id, before: before as Prisma.InputJsonValue, after: after as Prisma.InputJsonValue, ip });
    }
    return detail(tx, companyId, id);
  });
}

export async function deleteCustomer(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
    const c = await load(tx, companyId, id);
    const uses = await referencesTo(tx, 'customers', id);
    if (uses.length > 0) {
      throw conflict(`"${c.name}" has been used (${describeReferences(uses)}), so it cannot be deleted. Switch it off instead.`);
    }
    await tx.customer.delete({ where: { id } });
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'customer.deleted',
      entityType: 'customer',
      entityId: id,
      before: { code: c.code, name: c.name, phone: c.phone },
      ip,
    });
    return { deleted: { id, code: c.code, name: c.name } };
  });
}