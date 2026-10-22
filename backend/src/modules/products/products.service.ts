import type { Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { describeReferences, referencesTo } from '../../shared/references.js';
import type {
  AddUnitInput,
  CreateProductInput,
  ProductListQuery,
  SetPricesInput,
  UpdateProductInput,
  UpdateUnitInput,
  UpdateCategoryInput,
} from './products.schemas.js';
import { isWhole } from './units.js';

// Rules in this file (the database repeats the important ones as a safety net):
//  * Stock is always counted in the product's BASE unit; other units only say "one of these = N base units".
//  * Once a product has stock history, its base unit is frozen. Once a unit appears on a purchase or sale line,
//    its conversion is frozen. Mistakes are fixed by switching the wrong unit off and adding a correct one.
//  * Units and products are never deleted, only switched off.

const productInclude = {
  category: { select: { id: true, name: true } },
  productUnits: { orderBy: [{ isBase: 'desc' }, { factorToBase: 'asc' }, { name: 'asc' }] },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type UnitRow = ProductRow['productUnits'][number];

const presentUnit = (u: UnitRow) => ({
  id: u.id,
  name: u.name,
  factor: u.factorToBase.toFixed(), // how many base units one of these holds ("50")
  isBase: u.isBase,
  isPurchaseUnit: u.isPurchaseUnit,
  isSaleUnit: u.isSaleUnit,
  barcode: u.barcode,
  status: u.status,
});

const presentProduct = (p: ProductRow) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  status: p.status,
  category: p.category,
  baseUnit: p.baseUnit,
  allowFractions: p.allowFractions,
  units: p.productUnits.map(presentUnit),
});

// ───────────────────────── helpers ─────────────────────────

/** Makes people who change the same product take turns (released when the transaction ends). */
async function lockProduct(tx: Tx, companyId: string, productId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM products WHERE id = ${productId}::uuid AND "companyId" = ${companyId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound('Product not found');
}

async function loadProduct(tx: Tx, companyId: string, productId: string): Promise<ProductRow> {
  const p = await tx.product.findFirst({ where: { id: productId, companyId }, include: productInclude });
  if (!p) throw notFound('Product not found');
  return p;
}

/** Has this product been used in stock or on documents? Then its base unit and used conversions are frozen. */
async function history(tx: Tx, companyId: string, productId: string) {
  const [movement, receiptUnits, saleUnits] = await Promise.all([
    tx.stockMovement.findFirst({ where: { companyId, productId }, select: { id: true } }),
    tx.purchaseReceiptLine.findMany({ where: { companyId, productId }, select: { productUnitId: true }, distinct: ['productUnitId'] }),
    tx.saleLine.findMany({ where: { companyId, productId }, select: { productUnitId: true }, distinct: ['productUnitId'] }),
  ]);
  const usedUnitIds = [...new Set([...receiptUnits, ...saleUnits].map((x) => x.productUnitId))];
  return { hasHistory: Boolean(movement) || usedUnitIds.length > 0, usedUnitIds };
}

async function detail(tx: Tx, companyId: string, productId: string) {
  const p = await loadProduct(tx, companyId, productId);
  const [h, prices] = await Promise.all([
    history(tx, companyId, productId),
    tx.productPrice.findMany({ where: { companyId, productId } }),
  ]);
  return {
    product: {
      ...presentProduct(p),
      // The screens use these to grey out what can no longer be changed.
      locks: { baseUnitLocked: h.hasHistory, usedUnitIds: h.usedUnitIds },
      prices: prices.map((x) => ({ priceListId: x.priceListId, unitId: x.productUnitId, price: x.price.toFixed(4) })),
    },
  };
}

async function assertCategory(tx: Tx, companyId: string, id: string) {
  const c = await tx.category.findFirst({
    where: { id, companyId },
    select: { status: true }
  });
  if (!c) throw badRequest('That category does not exist');
  if (c.status !== 'ACTIVE') throw badRequest('That category is switched off. Choose another one or switch it back on.');
}

async function assertSkuFree(tx: Tx, companyId: string, sku: string, exceptProductId?: string) {
  const taken = await tx.product.findUnique({ where: { companyId_sku: { companyId, sku } }, select: { id: true, name: true } });
  if (taken && taken.id !== exceptProductId) throw conflict(`The code ${sku} is already used by "${taken.name}"`);
}

/** A scanner must find exactly one unit, so a barcode can exist only once in the whole company. */
async function assertBarcodesFree(tx: Tx, companyId: string, codes: string[], exceptUnitId?: string) {
  if (codes.length === 0) return;
  const taken = await tx.productUnit.findFirst({
    where: { companyId, barcode: { in: codes }, ...(exceptUnitId ? { id: { not: exceptUnitId } } : {}) },
    select: { barcode: true, name: true, product: { select: { name: true } } },
  });
  if (taken) throw conflict(`The barcode ${taken.barcode} is already used on "${taken.product.name}" (${taken.name})`);
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function generateSku(tx: Tx, companyId: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const sku = await nextDocumentNumber(tx, companyId, 'SKU', { prefix: 'P' });
    if (!(await tx.product.findUnique({ where: { companyId_sku: { companyId, sku } }, select: { id: true } }))) return sku;
  }
  throw conflict('Could not make a free product code. Type one yourself.');
}

// ───────────────────────── categories and price lists ─────────────────────────

export async function listCategories(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.category.findMany({
      where: { companyId: auth.companyId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    }),
  );
  return { 
    categories: rows.map((c) => ({ 
      id: c.id,
      name: c.name,
      productCount: c._count.products,
      status: c.status,
    }))
  };
}

async function assertCategoryNameFree(tx: Tx, companyId: string, name: string, exceptId?: string) {
  const taken = await tx.category.findFirst({
    where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (taken) throw conflict(`There is already a category called "${name}"`);
}

export async function createCategory(auth: AuthContext, name: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    await assertCategoryNameFree(tx, auth.companyId, name);
    const c = await tx.category.create({ data: { companyId: auth.companyId, name } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'category.created', entityType: 'category', entityId: c.id, after: { name }, ip });
    return { 
      category: { id: c.id, name: c.name, status: c.status, productCount: 0 } 
    };
  });
}

export async function updateCategory(auth: AuthContext, id: string, input: UpdateCategoryInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const before = await tx.category.findFirst({ where: { id, companyId: auth.companyId } });
    if (!before) throw notFound('Category not found');
    if (input.name !== undefined && input.name !== before.name) await assertCategoryNameFree(tx, auth.companyId, input.name, id);
    const c = await tx.category.update({
      where: { id },
      data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.status !== undefined ? { status: input.status } : {}) },
      include: { _count: { select: { products: true } } },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'category.updated',
      entityType: 'category',
      entityId: id,
      before: { name: before.name, status: before.status },
      after: { name: c.name, status: c.status },
      ip,
    });
    return { category: { id: c.id, name: c.name, status: c.status, productCount: c._count.products } };
  });
}

/**
 * Deletes a category that was created by mistake. Only an unused one can go: if any product still
 * uses it, switch it off instead (so old products keep their category).
 */
export async function deleteCategory(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const c = await tx.category.findFirst({ where: { id, companyId: auth.companyId } });
    if (!c) throw notFound('Category not found');
    const uses = await referencesTo(tx, 'categories', id);
    if (uses.length > 0) {
      throw conflict(`"${c.name}" is still used (${describeReferences(uses)}), so it cannot be deleted. Switch it off instead.`);
    }
    await tx.category.delete({ where: { id } });
    await writeAudit(tx, { companyId: auth.companyId, userId: auth.userId, action: 'category.deleted', entityType: 'category', entityId: id, before: { name: c.name }, ip });
    return { deleted: { id, name: c.name } };
  });
}

export async function listPriceLists(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.priceList.findMany({ where: { companyId: auth.companyId }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }),
  );
  return { 
    priceLists: rows.map((l) => ({ 
      id: l.id,
      name: l.name,
      kind: l.kind,
      status: l.status,
      isDefault: l.isDefault
    }))
  };
}

// ───────────────────────── products ─────────────────────────

export async function listProducts(auth: AuthContext, q: ProductListQuery) {
  return withTenant(auth, async (tx) => {
    const where: Prisma.ProductWhereInput = {
      companyId: auth.companyId,
      ...(q.status !== 'ALL' ? { status: q.status } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.search
        ? {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { sku: { contains: q.search, mode: 'insensitive' } },
            { productUnits: { some: { barcode: { contains: q.search, mode: 'insensitive' } } } },
          ],
        }
        : {}),
    };
    const rows = await tx.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      ...pageArgs(q),
    });
    const page = toPage(rows, q.limit);
    return { items: page.items.map(presentProduct), nextCursor: page.nextCursor };
  });
}

export const getProduct = (auth: AuthContext, id: string) =>
  withTenant(auth, (tx) => detail(tx, auth.companyId, id));

/** What a barcode scanner calls: which product and which unit does this code belong to? */
export async function findByBarcode(auth: AuthContext, code: string) {
  return withTenant(auth, async (tx) => {
    const unit = await tx.productUnit.findFirst({ where: { companyId: auth.companyId, barcode: code }, select: { id: true, productId: true } });
    if (!unit) throw notFound('No product has this barcode');
    const p = await loadProduct(tx, auth.companyId, unit.productId);
    return { product: presentProduct(p), unit: presentUnit(p.productUnits.find((u) => u.id === unit.id)!) };
  });
}

export async function createProduct(auth: AuthContext, input: CreateProductInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    if (input.categoryId) await assertCategory(tx, companyId, input.categoryId);
    const sku = input.sku ?? (await generateSku(tx, companyId));
    await assertSkuFree(tx, companyId, sku);
    const codes = [input.baseUnit.barcode, ...input.units.map((u) => u.barcode)].filter((b): b is string => !!b);
    await assertBarcodesFree(tx, companyId, codes);

    const product = await tx.product.create({
      data: {
        companyId,
        sku,
        name: input.name,
        categoryId: input.categoryId ?? null,
        baseUnit: input.baseUnit.name,
        allowFractions: input.allowFractions,
      },
    });
    // The base unit is a unit like any other (factor 1), so prices and sale lines can always point at a unit.
    // Created one at a time on purpose: the database checks each new unit against the earlier ones.
    await tx.productUnit.create({
      data: {
        companyId,
        productId: product.id,
        name: input.baseUnit.name,
        factorToBase: 1,
        isBase: true,
        isPurchaseUnit: true,
        isSaleUnit: true,
        barcode: input.baseUnit.barcode ?? null,
      },
    });
    for (const u of input.units) {
      await tx.productUnit.create({
        data: {
          companyId,
          productId: product.id,
          name: u.name,
          factorToBase: u.factor,
          isPurchaseUnit: u.isPurchaseUnit,
          isSaleUnit: u.isSaleUnit,
          barcode: u.barcode ?? null,
        },
      });
    }
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'product.created',
      entityType: 'product',
      entityId: product.id,
      after: { sku, name: input.name, baseUnit: input.baseUnit.name, allowFractions: input.allowFractions, units: input.units.map((u) => `${u.name}=${u.factor}`) },
      ip,
    });
    return detail(tx, companyId, product.id);
  });
}

const FROZEN =
  'This product already has stock history, so its base unit and whole-number rule can no longer change. ' +
  'To fix a mistake, create a new product and move the stock with an adjustment.';

export async function updateProduct(auth: AuthContext, id: string, input: UpdateProductInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await lockProduct(tx, companyId, id);
    const before = await loadProduct(tx, companyId, id);
    const h = await history(tx, companyId, id);
    const data: Prisma.ProductUpdateInput = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.status !== undefined) data.status = input.status;
    if (input.categoryId !== undefined) {
      if (input.categoryId && input.categoryId !== before.categoryId) {
        await assertCategory(tx, companyId, input.categoryId);
      }
      data.category = input.categoryId ? { connect: { id: input.categoryId } } : { disconnect: true };
    }
    if (input.sku !== undefined && input.sku !== before.sku) {
      await assertSkuFree(tx, companyId, input.sku, id);
      data.sku = input.sku;
    }

    let renameBaseTo: string | null = null;
    if (input.baseUnitName !== undefined && input.baseUnitName !== before.baseUnit) {
      if (h.hasHistory) throw conflict(FROZEN);
      if (before.productUnits.some((u) => !u.isBase && sameName(u.name, input.baseUnitName!))) {
        throw conflict(`This product already has a unit called "${input.baseUnitName}"`);
      }
      data.baseUnit = input.baseUnitName;
      renameBaseTo = input.baseUnitName;
    }
    if (input.allowFractions !== undefined && input.allowFractions !== before.allowFractions) {
      if (!input.allowFractions) {
        if (h.hasHistory) throw conflict(FROZEN);
        const fractional = before.productUnits.find((u) => !isWhole(u.factorToBase));
        if (fractional) {
          throw conflict(`The package "${fractional.name}" holds ${fractional.factorToBase.toFixed()} base units. Fix or switch off that package first.`);
        }
      }
      data.allowFractions = input.allowFractions;
    }

    await tx.product.update({ where: { id }, data });
    if (renameBaseTo) {
      await tx.productUnit.updateMany({ where: { productId: id, isBase: true }, data: { name: renameBaseTo } });
    }
    const after = await loadProduct(tx, companyId, id);
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      before: { sku: before.sku, name: before.name, status: before.status, baseUnit: before.baseUnit, allowFractions: before.allowFractions, categoryId: before.categoryId },
      after: { sku: after.sku, name: after.name, status: after.status, baseUnit: after.baseUnit, allowFractions: after.allowFractions, categoryId: after.categoryId },
      ip,
    });
    return detail(tx, companyId, id);
  });
}

/**
 * Permanently deletes a product that was created by mistake and never used (Admin only, see the route).
 * "Used" means anything at all still points at it: stock, purchases, sales, counts, transfers...
 * (found from the database's own foreign keys, so later steps are covered automatically).
 * A used product is switched off instead. Its units and prices are removed together with it.
 */
export async function deleteProduct(auth: AuthContext, id: string, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await lockProduct(tx, companyId, id);
    const p = await loadProduct(tx, companyId, id);
    const uses = await referencesTo(tx, 'products', id, ['product_units', 'product_prices']);
    if (uses.length > 0) {
      throw conflict(`"${p.name}" has been used (${describeReferences(uses)}), so it cannot be deleted. Switch it off instead.`);
    }
    const prices = await tx.productPrice.deleteMany({ where: { productId: id } });
    await tx.productUnit.deleteMany({ where: { productId: id } });
    await tx.product.delete({ where: { id } });
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'product.deleted',
      entityType: 'product',
      entityId: id,
      before: { sku: p.sku, name: p.name, baseUnit: p.baseUnit, units: p.productUnits.map((u) => `${u.name}=${u.factorToBase.toFixed()}`), pricesRemoved: prices.count },
      ip,
    });
    return { deleted: { id, sku: p.sku, name: p.name } };
  });
}

// ───────────────────────── units ─────────────────────────

function assertFactorFitsProduct(p: { allowFractions: boolean }, factor: string) {
  if (!p.allowFractions && !isWhole(factor)) {
    throw badRequest('This product is counted in whole pieces, so a package must hold a whole number of them');
  }
}

export async function addUnit(auth: AuthContext, productId: string, input: AddUnitInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await lockProduct(tx, companyId, productId);
    const p = await loadProduct(tx, companyId, productId);
    if (p.productUnits.some((u) => sameName(u.name, input.name))) {
      throw conflict(`This product already has a unit called "${input.name}"`);
    }
    assertFactorFitsProduct(p, input.factor);
    if (input.barcode) await assertBarcodesFree(tx, companyId, [input.barcode]);

    const unit = await tx.productUnit.create({
      data: {
        companyId,
        productId,
        name: input.name,
        factorToBase: input.factor,
        isPurchaseUnit: input.isPurchaseUnit,
        isSaleUnit: input.isSaleUnit,
        barcode: input.barcode ?? null,
      },
    });
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'product_unit.created',
      entityType: 'product_unit',
      entityId: unit.id,
      after: { product: p.name, unit: input.name, factor: input.factor, barcode: input.barcode ?? null },
      ip,
    });
    return detail(tx, companyId, productId);
  });
}

export async function updateUnit(auth: AuthContext, productId: string, unitId: string, input: UpdateUnitInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await lockProduct(tx, companyId, productId);
    const p = await loadProduct(tx, companyId, productId);
    const unit = p.productUnits.find((u) => u.id === unitId);
    if (!unit) throw notFound('Unit not found');
    const data: Prisma.ProductUnitUpdateInput = {};

    if (unit.isBase) {
      // The base unit is the yardstick everything else is measured in.
      const forbidden = (['name', 'factor', 'status', 'isSaleUnit', 'isPurchaseUnit'] as const).filter((k) => input[k] !== undefined);
      if (forbidden.length) {
        throw badRequest('The base unit cannot be renamed here, switched off or converted. Rename it from the product settings (only before it has stock history).');
      }
    } else {
      if (input.name !== undefined && !sameName(input.name, unit.name)) {
        if (p.productUnits.some((u) => u.id !== unitId && sameName(u.name, input.name!))) {
          throw conflict(`This product already has a unit called "${input.name}"`);
        }
        data.name = input.name;
      }
      if (input.factor !== undefined && !D(input.factor).equals(unit.factorToBase)) {
        const { usedUnitIds } = await history(tx, companyId, productId);
        if (usedUnitIds.includes(unitId)) {
          throw conflict(
            `"${unit.name}" is already used on purchases or sales, so its conversion cannot change without changing history. ` +
            'Switch this unit off and add a new unit with the correct conversion.',
          );
        }
        assertFactorFitsProduct(p, input.factor);
        data.factorToBase = input.factor;
      }
      if (input.isPurchaseUnit !== undefined) data.isPurchaseUnit = input.isPurchaseUnit;
      if (input.isSaleUnit !== undefined) data.isSaleUnit = input.isSaleUnit;
      if (input.status !== undefined) data.status = input.status;
    }
    if (input.barcode !== undefined && input.barcode !== unit.barcode) {
      if (input.barcode) await assertBarcodesFree(tx, companyId, [input.barcode], unitId);
      data.barcode = input.barcode;
    }

    if (Object.keys(data).length > 0) {
      const updated = await tx.productUnit.update({ where: { id: unitId }, data });
      await writeAudit(tx, {
        companyId,
        userId: auth.userId,
        action: 'product_unit.updated',
        entityType: 'product_unit',
        entityId: unitId,
        before: { name: unit.name, factor: unit.factorToBase.toFixed(), barcode: unit.barcode, status: unit.status, isSaleUnit: unit.isSaleUnit, isPurchaseUnit: unit.isPurchaseUnit },
        after: { name: updated.name, factor: updated.factorToBase.toFixed(), barcode: updated.barcode, status: updated.status, isSaleUnit: updated.isSaleUnit, isPurchaseUnit: updated.isPurchaseUnit },
        ip,
      });
    }
    return detail(tx, companyId, productId);
  });
}

// ───────────────────────── prices ─────────────────────────

/** Sets (or removes, with price null) the selling price of a unit on a price list. A unit with no price is simply not sold there. */
export async function setPrices(auth: AuthContext, productId: string, input: SetPricesInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const p = await loadProduct(tx, companyId, productId);
    const lists = new Map((await tx.priceList.findMany({ where: { companyId } })).map((l) => [l.id, l]));

    const seen = new Set<string>();
    for (const row of input.prices) {
      const key = `${row.priceListId}:${row.unitId}`;
      if (seen.has(key)) throw badRequest('The same price list and unit appear twice');
      seen.add(key);
      /* if (!lists.has(row.priceListId)) throw badRequest('That price list does not exist'); */
      const list = lists.get(row.priceListId);
      if (!list) throw badRequest('That price list does not exist');
      if (row.price !== null && list.status !== 'ACTIVE') throw badRequest(`The price list "${list.name}" is switched off`);
      const unit = p.productUnits.find((u) => u.id === row.unitId);
      if (!unit) throw badRequest('That unit does not belong to this product');
      if (row.price !== null && (unit.status !== 'ACTIVE' || !unit.isSaleUnit)) {
        throw badRequest(`"${unit.name}" is not an active selling unit, so it cannot have a price`);
      }
    }

    const before = await tx.productPrice.findMany({ where: { companyId, productId } });
    for (const row of input.prices) {
      if (row.price === null) {
        await tx.productPrice.deleteMany({ where: { priceListId: row.priceListId, productUnitId: row.unitId } });
      } else {
        await tx.productPrice.upsert({
          where: { priceListId_productUnitId: { priceListId: row.priceListId, productUnitId: row.unitId } },
          update: { price: row.price },
          create: { companyId, priceListId: row.priceListId, productId, productUnitId: row.unitId, price: row.price },
        });
      }
    }
    const describe = (rows: { priceListId: string; productUnitId: string; price: Prisma.Decimal }[]) =>
      rows.map((x) => `${lists.get(x.priceListId)?.name ?? '?'} / ${p.productUnits.find((u) => u.id === x.productUnitId)?.name ?? '?'} = ${x.price.toFixed(4)}`).sort();
    const afterRows = await tx.productPrice.findMany({ where: { companyId, productId } });
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'prices.updated',
      entityType: 'product',
      entityId: productId,
      before: { product: p.name, prices: describe(before) },
      after: { product: p.name, prices: describe(afterRows) },
      ip,
    });
    return detail(tx, companyId, productId);
  });
}