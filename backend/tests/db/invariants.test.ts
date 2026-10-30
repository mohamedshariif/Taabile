// Database invariants: the rules that keep the books and stock honest even if application code has a bug.
// Runs on an in-memory Postgres (PGlite): no Docker needed.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDdl } from '../helpers/ddl.js';

let db: PGlite;

interface Co {
  companyId: string;
  periodId: string;
  cash: string;
  sales: string;
  locationId: string;
  productId: string;
}

const uid = () => crypto.randomUUID();
let n = 0;
const next = () => `${++n}`;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] as T;
}

async function seedCompany(name: string, year = 2026, month = 10): Promise<Co> {
  const c = await one<{ id: string }>(
    `INSERT INTO companies (name, country, "updatedAt") VALUES ($1, 'SS', now()) RETURNING id`, [name]);
  const p = await one<{ id: string }>(
    `INSERT INTO accounting_periods ("companyId", year, month) VALUES ($1, $2, $3) RETURNING id`, [c.id, year, month]);
  const cash = await one<{ id: string }>(
    `INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, '1010', 'Cash', 'ASSET') RETURNING id`, [c.id]);
  const sales = await one<{ id: string }>(
    `INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, '4100', 'Sales', 'REVENUE') RETURNING id`, [c.id]);
  const loc = await one<{ id: string }>(
    `INSERT INTO locations ("companyId", name, code, type) VALUES ($1, 'Store A', 'A', 'STORE') RETURNING id`, [c.id]);
  const prod = await one<{ id: string }>(
    `INSERT INTO products ("companyId", sku, name, "baseUnit", "updatedAt") VALUES ($1, 'RICE', 'Rice', 'kg', now()) RETURNING id`, [c.id]);
  return { companyId: c.id, periodId: p.id, cash: cash.id, sales: sales.id, locationId: loc.id, productId: prod.id };
}
/** Stock arrives the way the engine does it: a movement AND the matching balance, together (the database refuses either alone). */
async function stockIn(co: Co, productId: string, qty: number, locationId = co.locationId, type = 'RECEIPT') {
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO stock_movements ("companyId", "locationId", "productId", type, quantity, "refType", "createdById")
       VALUES ($1, $2, $3, $4, $5, 'TEST', $6)`, [co.companyId, locationId, productId, type, qty, uid()]);
    await tx.query(
      `INSERT INTO stock_balances ("companyId", "locationId", "productId", "onHand", "updatedAt") VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("locationId", "productId") DO UPDATE SET "onHand" = stock_balances."onHand" + EXCLUDED."onHand"`,
      [co.companyId, locationId, productId, qty]);
  });
}

type Tx = { query: PGlite['query'] };
async function entry(tx: Tx, co: Co, lines: [string, number, number][], date = '2026-10-13') {
  const e = await tx.query<{ id: string }>(
    `INSERT INTO journal_entries ("companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
     VALUES ($1, $2, $3, $4, 'test', 'TEST', $5, $6) RETURNING id`,
    [co.companyId, next(), date, co.periodId, `key-${next()}`, uid()]);
  const id = e.rows[0]!.id;
  for (const [account, debit, credit] of lines) {
    await tx.query(
      `INSERT INTO journal_lines ("companyId", "entryId", "accountId", debit, credit) VALUES ($1, $2, $3, $4, $5)`,
      [co.companyId, id, account, debit, credit]);
  }
  return id;
}

let A: Co;
let B: Co;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(buildDdl());
  await db.exec(readFileSync('prisma/constraints.sql', 'utf8'));
  await db.exec(`CREATE ROLE taabile_app LOGIN;`);
  await db.exec(readFileSync('prisma/grants.sql', 'utf8'));
  A = await seedCompany('Company A');
  B = await seedCompany('Company B');
});

describe('journals', () => {
  it('accepts a balanced entry', async () => {
    await db.transaction(async (tx) => {
      await entry(tx, A, [[A.cash, 100, 0], [A.sales, 0, 100]]);
    });
    const r = await one<{ d: string; c: string }>(
      `SELECT sum(debit)::text d, sum(credit)::text c FROM journal_lines WHERE "companyId" = $1`, [A.companyId]);
    expect(r.d).toBe(r.c);
  });

  it('rejects an unbalanced entry at commit', async () => {
    await expect(
      db.transaction(async (tx) => { await entry(tx, A, [[A.cash, 100, 0], [A.sales, 0, 99]]); }),
    ).rejects.toThrow(/not balanced/);
  });

  it('rejects an entry with fewer than two lines', async () => {
    await expect(
      db.transaction(async (tx) => { await entry(tx, A, [[A.cash, 100, 0]]); }),
    ).rejects.toThrow(/at least two lines|not balanced/);
  });

  it('rejects an entry with no lines at all', async () => {
    await expect(
      db.transaction(async (tx) => { await entry(tx, A, []); }),
    ).rejects.toThrow(/at least two lines/);
  });

  it('rejects a line with both debit and credit, or neither', async () => {
    await expect(db.transaction(async (tx) => { await entry(tx, A, [[A.cash, 50, 50], [A.sales, 0, 0]]); })).rejects.toThrow();
  });

  it('rejects the same posting key twice (no double posting)', async () => {
    const key = `dup-${next()}`;
    const insert = (tx: Tx) => tx.query(
      `INSERT INTO journal_entries ("companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
       VALUES ($1, $2, '2026-10-13', $3, 't', 'TEST', $4, $5)`, [A.companyId, next(), A.periodId, key, uid()]);
    await db.transaction(async (tx) => {
      await insert(tx);
      await tx.query(`INSERT INTO journal_lines ("companyId", "entryId", "accountId", debit) SELECT $1, id, $2, 1 FROM journal_entries WHERE "postingKey" = $3`, [A.companyId, A.cash, key]);
      await tx.query(`INSERT INTO journal_lines ("companyId", "entryId", "accountId", credit) SELECT $1, id, $2, 1 FROM journal_entries WHERE "postingKey" = $3`, [A.companyId, A.sales, key]);
    });
    await expect(db.transaction(async (tx) => { await insert(tx); })).rejects.toThrow(/unique|duplicate/i);
  });

  it('cannot be edited or deleted, even by the owner', async () => {
    await expect(db.query(`UPDATE journal_lines SET debit = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM journal_lines`)).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE journal_entries SET description = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE journal_lines`)).rejects.toThrow(/append-only/);
  });
});

describe('accounting periods', () => {
  it('rejects entries into a locked period', async () => {
    const L = await seedCompany('Locked Co', 2026, 9);
    await db.query(`UPDATE accounting_periods SET status = 'LOCKED' WHERE id = $1`, [L.periodId]);
    await expect(
      db.transaction(async (tx) => { await entry(tx, L, [[L.cash, 5, 0], [L.sales, 0, 5]], '2026-09-10'); }),
    ).rejects.toThrow(/locked/);
  });

  it('rejects an entry dated outside its period', async () => {
    await expect(
      db.transaction(async (tx) => { await entry(tx, A, [[A.cash, 5, 0], [A.sales, 0, 5]], '2026-11-02'); }),
    ).rejects.toThrow(/outside period/);
  });
});

describe('stock', () => {
  const balance = (co: Co, onHand: number, committed: number) =>
    db.query(
      `INSERT INTO stock_balances ("companyId", "locationId", "productId", "onHand", committed, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())`, [co.companyId, co.locationId, co.productId, onHand, committed]);

  it('rejects negative stock', async () => {
    await expect(balance(A, -1, 0)).rejects.toThrow();
  });

  it('rejects committing more than is on hand (available can never be negative)', async () => {
    await expect(balance(A, 10, 11)).rejects.toThrow();
  });

  it('accepts on hand with part committed, and blocks overselling the last units', async () => {
    await stockIn(A, A.productId, 20);
    await db.query(`UPDATE stock_balances SET committed = 5 WHERE "companyId" = $1`, [A.companyId]);
    await expect(
      db.query(`UPDATE stock_balances SET committed = 21 WHERE "companyId" = $1`, [A.companyId]),
    ).rejects.toThrow();
  });

  it('stock movements are append-only', async () => {
    await stockIn(A, A.productId, 20);
    await expect(db.query(`UPDATE stock_movements SET quantity = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM stock_movements`)).rejects.toThrow(/append-only/);
  });
});

describe('tenant isolation', () => {
  /** Run as the API's database user with a company selected, like the API does per request. */
  async function asCompany<T>(companyId: string | null, fn: (tx: Tx & { exec: PGlite['exec'] }) => Promise<T>) {
    return db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE taabile_app`);
      if (companyId) await tx.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      return fn(tx);
    });
  }

  it("a company sees only its own rows", async () => {
    const rowsA = await asCompany(A.companyId, (tx) => tx.query<{ companyId: string }>(`SELECT "companyId" FROM accounts`));
    expect(rowsA.rows.length).toBeGreaterThan(0);
    expect(rowsA.rows.every((r) => r.companyId === A.companyId)).toBe(true);
  });

  it('with no company selected, nothing is visible', async () => {
    const rows = await asCompany(null, (tx) => tx.query(`SELECT * FROM accounts`));
    expect(rows.rows.length).toBe(0);
  });

  it("a company cannot write into another company's data", async () => {
    await expect(
      asCompany(A.companyId, (tx) =>
        tx.query(`INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, '9999', 'Sneaky', 'ASSET')`, [B.companyId])),
    ).rejects.toThrow(/row-level security/);
  });

  it('a company cannot read the companies table beyond itself', async () => {
    const rows = await asCompany(A.companyId, (tx) => tx.query<{ id: string }>(`SELECT id FROM companies`));
    expect(rows.rows.map((r) => r.id)).toEqual([A.companyId]);
  });
});

describe('runtime permissions', () => {
  it('the API user cannot update or delete ledgers, or delete documents', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE taabile_app`);
      await tx.query(`UPDATE journal_lines SET debit = 1`);
    })).rejects.toThrow(/permission denied/);
    await expect(db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE taabile_app`);
      await tx.query(`DELETE FROM sales`);
    })).rejects.toThrow(/permission denied/);
  });
});

describe('payments', () => {
  it('a payment allocation must point at exactly one document', async () => {
    const cust = await one<{ id: string }>(
      `INSERT INTO customers ("companyId", code, name) VALUES ($1, 'C1', 'Customer') RETURNING id`, [A.companyId]);
    const fa = await one<{ id: string }>(
      `INSERT INTO financial_accounts ("companyId", name, type, "locationId", "ledgerAccountId") VALUES ($1, 'Till A', 'CASH', $2, $3) RETURNING id`,
      [A.companyId, A.locationId, A.cash]);
    const pay = await one<{ id: string }>(
      `INSERT INTO payments ("companyId", number, "partyType", "customerId", "financialAccountId", method, amount, "paidAt", "createdById")
       VALUES ($1, 'P1', 'CUSTOMER', $2, $3, 'CASH', 100, now(), $4) RETURNING id`, [A.companyId, cust.id, fa.id, uid()]);
    await expect(db.query(
      `INSERT INTO payment_allocations ("companyId", "paymentId", amount, "createdById") VALUES ($1, $2, 50, $3)`,
      [A.companyId, pay.id, uid()])).rejects.toThrow();
  });

  it('a supplier payment cannot name a customer', async () => {
    const cust = await one<{ id: string }>(
      `INSERT INTO customers ("companyId", code, name) VALUES ($1, 'C2', 'Customer 2') RETURNING id`, [A.companyId]);
    const fa = await one<{ id: string }>(`SELECT id FROM financial_accounts WHERE "companyId" = $1 LIMIT 1`, [A.companyId]);
    await expect(db.query(
      `INSERT INTO payments ("companyId", number, "partyType", "customerId", "financialAccountId", method, amount, "paidAt", "createdById")
       VALUES ($1, 'P2', 'SUPPLIER', $2, $3, 'CASH', 10, now(), $4)`, [A.companyId, cust.id, fa.id, uid()])).rejects.toThrow();
  });
});

describe('products and units', () => {
  const product = async (co: Co, sku: string, extra = '') =>
    (await one<{ id: string }>(
      `INSERT INTO products ("companyId", sku, name, "baseUnit", "updatedAt" ${extra ? ', "allowFractions"' : ''})
       VALUES ($1, $2, $2, 'kg', now() ${extra ? ', ' + extra : ''}) RETURNING id`, [co.companyId, sku])).id;
  const unit = (co: Co, productId: string, name: string, factor: number | string, more = '') =>
    one<{ id: string }>(
      `INSERT INTO product_units ("companyId", "productId", name, "factorToBase" ${more ? ', ' + more.split('=')[0] : ''})
       VALUES ($1, $2, $3, $4 ${more ? ', ' + more.split('=')[1] : ''}) RETURNING id`, [co.companyId, productId, name, factor]);

  it('the base unit must convert at exactly 1', async () => {
    const p = await product(A, 'U1');
    await expect(unit(A, p, 'kg', 2, '"isBase"=true')).rejects.toThrow(/product_units_base_factor|check/);
    await unit(A, p, 'kg', 1, '"isBase"=true');
  });

  it('a product has one base unit only', async () => {
    const p = await product(A, 'U2');
    await unit(A, p, 'kg', 1, '"isBase"=true');
    await expect(unit(A, p, 'litre', 1, '"isBase"=true')).rejects.toThrow(/only one base unit/);
  });

  it('unit names are unique per product ignoring upper/lower case, but another product may reuse the name', async () => {
    const p = await product(A, 'U3');
    const q = await product(A, 'U4');
    await unit(A, p, 'Sack', 50);
    await expect(unit(A, p, 'SACK', 25)).rejects.toThrow(/already has a unit/);
    await unit(A, q, 'Sack', 50);
  });

  it('conversions must be positive and not absurd', async () => {
    const p = await product(A, 'U5');
    await expect(unit(A, p, 'zero', 0)).rejects.toThrow();
    await expect(unit(A, p, 'huge', 2000000)).rejects.toThrow();
  });

  it('a barcode exists once per company, and units without one never clash', async () => {
    const p = await product(A, 'U6');
    await unit(A, p, 'Carton', 12, `barcode='6001234567890'`);
    await expect(unit(A, p, 'Bottle', 1, `barcode='6001234567890'`)).rejects.toThrow(/unique|duplicate/i);
    await unit(A, p, 'Tin', 1);
    await unit(A, p, 'Pack', 6);
    const q = await product(B, 'U6');
    await unit(B, q, 'Carton', 12, `barcode='6001234567890'`); // another company, so no clash
  });

  it('once a unit is on a purchase line its conversion is frozen (name and barcode stay editable)', async () => {
    const p = await product(A, 'U7');
    const used = await unit(A, p, 'Sack 50', 50);
    const spare = await unit(A, p, 'Sack 25', 25);
    const sup = await one<{ id: string }>(`INSERT INTO suppliers ("companyId", code, name) VALUES ($1, $2, 'Sup') RETURNING id`, [A.companyId, `S${next()}`]);
    const rec = await one<{ id: string }>(
      `INSERT INTO purchase_receipts ("companyId", number, "supplierId", "locationId", "receivedAt", "goodsTotal", total, "createdById")
       VALUES ($1, $2, $3, $4, now(), 100, 100, $5) RETURNING id`, [A.companyId, `R${next()}`, sup.id, A.locationId, uid()]);
    await db.query(
      `INSERT INTO purchase_receipt_lines ("companyId", "receiptId", "productId", "productUnitId", "qtyExpected", "qtyReceived", "qtyReceivedBase", "unitCost", "landedUnitCostBase", "lineTotal")
       VALUES ($1, $2, $3, $4, 2, 2, 100, 50, 1, 100)`, [A.companyId, rec.id, p, used.id]);

    await expect(db.query(`UPDATE product_units SET "factorToBase" = 40 WHERE id = $1`, [used.id])).rejects.toThrow(/already used on documents/);
    await db.query(`UPDATE product_units SET name = 'Sack of 50 kg', barcode = 'SACK50BARCODE' WHERE id = $1`, [used.id]);
    await db.query(`UPDATE product_units SET "factorToBase" = 30 WHERE id = $1`, [spare.id]); // never used: still correctable
  });

  it('once a product has stock movements its base unit and whole-number rule are frozen', async () => {
    const p = await product(A, 'U8');
    await db.query(`UPDATE products SET "baseUnit" = 'litre', "allowFractions" = true WHERE id = $1`, [p]); // no history yet: fine
    await stockIn(A, p, 5);
    await expect(db.query(`UPDATE products SET "baseUnit" = 'kg' WHERE id = $1`, [p])).rejects.toThrow(/stock history/);
    await expect(db.query(`UPDATE products SET "allowFractions" = false WHERE id = $1`, [p])).rejects.toThrow(/stock history/);
    await db.query(`UPDATE products SET name = 'Renamed', status = 'INACTIVE' WHERE id = $1`, [p]); // other fields stay editable
  });

  it('allowing fractions later is harmless and stays possible', async () => {
    const p = await product(A, 'U9');
    await stockIn(A, p, 5);
    await db.query(`UPDATE products SET "allowFractions" = true WHERE id = $1`, [p]);
  });
});

describe('delete protection', () => {
  const countRows = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

  it('a category that products use cannot be deleted, and the products keep their category (nothing is blanked)', async () => {
    const cat = await one<{ id: string }>(`INSERT INTO categories ("companyId", name) VALUES ($1, $2) RETURNING id`, [A.companyId, `Used ${next()}`]);
    const p = await one<{ id: string }>(
      `INSERT INTO products ("companyId", sku, name, "baseUnit", "categoryId", "updatedAt") VALUES ($1, $2, 'Oil', 'bottle', $3, now()) RETURNING id`,
      [A.companyId, `DP${next()}`, cat.id]);
    await expect(db.query(`DELETE FROM categories WHERE id = $1`, [cat.id])).rejects.toThrow(/foreign key|violates/i);
    expect(await countRows(`SELECT count(*) AS n FROM products WHERE id = $1 AND "categoryId" = $2`, [p.id, cat.id])).toBe(1);
  });

  it('an unused category can be deleted', async () => {
    const cat = await one<{ id: string }>(`INSERT INTO categories ("companyId", name) VALUES ($1, $2) RETURNING id`, [A.companyId, `Spare ${next()}`]);
    await db.query(`DELETE FROM categories WHERE id = $1`, [cat.id]);
    expect(await countRows(`SELECT count(*) AS n FROM categories WHERE id = $1`, [cat.id])).toBe(0);
  });

  it('a price list that a customer uses cannot be deleted, and the customer keeps it', async () => {
    const list = await one<{ id: string }>(`INSERT INTO price_lists ("companyId", name, kind) VALUES ($1, $2, 'WHOLESALE') RETURNING id`, [A.companyId, `PL ${next()}`]);
    const c = await one<{ id: string }>(`INSERT INTO customers ("companyId", code, name, "priceListId") VALUES ($1, $2, 'Shop', $3) RETURNING id`, [A.companyId, `C${next()}`, list.id]);
    await expect(db.query(`DELETE FROM price_lists WHERE id = $1`, [list.id])).rejects.toThrow(/foreign key|violates/i);
    expect(await countRows(`SELECT count(*) AS n FROM customers WHERE id = $1 AND "priceListId" = $2`, [c.id, list.id])).toBe(1);
  });

  it('a product that has stock movements cannot be deleted', async () => {
    const p = await one<{ id: string }>(`INSERT INTO products ("companyId", sku, name, "baseUnit", "updatedAt") VALUES ($1, $2, 'Flour', 'kg', now()) RETURNING id`, [A.companyId, `DP${next()}`]);
    await stockIn(A, p.id, 5);
    await expect(db.query(`DELETE FROM products WHERE id = $1`, [p.id])).rejects.toThrow(/foreign key|violates/i);
  });
});


describe('stock rules (Step G)', () => {
  const move = (tx: Tx, co: Co, p: string, type: string, qty: number, over: { loc?: string; cost?: number; total?: number; reversalOf?: string } = {}) =>
    tx.query<{ id: string }>(
      `INSERT INTO stock_movements ("companyId", "locationId", "productId", type, quantity, "unitCost", "totalCost", "refType", "reversalOfId", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'TEST', $8, $9) RETURNING id`,
      [co.companyId, over.loc ?? co.locationId, p, type, qty, over.cost ?? 0, over.total ?? 0, over.reversalOf ?? null, uid()]);
  const holds = (tx: Tx, co: Co, p: string, onHand: number) =>
    tx.query(
      `INSERT INTO stock_balances ("companyId", "locationId", "productId", "onHand", "updatedAt") VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("locationId", "productId") DO UPDATE SET "onHand" = EXCLUDED."onHand"`, [co.companyId, co.locationId, p, onHand]);
  const fresh = (name: string) => one<{ id: string }>(`INSERT INTO products ("companyId", sku, name, "baseUnit", "updatedAt") VALUES ($1, $2, $3, 'kg', now()) RETURNING id`, [A.companyId, `SR${next()}`, name]);

  it('a movement must point the right way for its type, and cannot be zero', async () => {
    const p = (await fresh('Dir')).id;
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', -5); await holds(tx, A, p, -5); })).rejects.toThrow();
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'SALE_RELEASE', 5); await holds(tx, A, p, 5); })).rejects.toThrow(/stock_movements_direction/);
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 0); })).rejects.toThrow(/stock_movements_direction/);
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'ADJUSTMENT', 3, { total: -1 }); await holds(tx, A, p, 3); })).rejects.toThrow(/stock_movements_direction/);
    await db.transaction(async (tx) => { await move(tx, A, p, 'ADJUSTMENT', 3, { cost: 2, total: 6 }); await holds(tx, A, p, 3); });
  });

  it('stock on hand must equal the sum of its movements, whichever side is changed alone', async () => {
    const p = (await fresh('Match')).id;
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 10); })).rejects.toThrow(/does not match/); // movement without balance
    await expect(db.transaction(async (tx) => { await holds(tx, A, p, 10); })).rejects.toThrow(/does not match/); // balance without movement
    await db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 10); await holds(tx, A, p, 10); });
    await expect(db.query(`UPDATE stock_balances SET "onHand" = 11 WHERE "productId" = $1`, [p])).rejects.toThrow(/does not match/); // quiet edit
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'SALE_RELEASE', -3); await holds(tx, A, p, 8); })).rejects.toThrow(/does not match/); // wrong maths
    await db.transaction(async (tx) => { await move(tx, A, p, 'SALE_RELEASE', -3); await holds(tx, A, p, 7); });
  });

  it('cannot move below zero even when the maths is "consistent"', async () => {
    const p = (await fresh('Neg')).id;
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'ADJUSTMENT', -2); await holds(tx, A, p, -2); })).rejects.toThrow(/stock_balances_valid/);
  });

  it('a movement must use a location and a product of its own company', async () => {
    const p = (await fresh('Own')).id;
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 1, { loc: B.locationId }); })).rejects.toThrow(/location of its own company/);
    await expect(db.transaction(async (tx) => { await move(tx, A, B.productId, 'RECEIPT', 1); })).rejects.toThrow(/product of its own company/);
  });

  it('a reversal must be the exact opposite of the movement it reverses', async () => {
    const p = (await fresh('Rev')).id;
    const id = await db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 10, { cost: 1, total: 10 }); await holds(tx, A, p, 10); const r = await tx.query<{ id: string }>(`SELECT id FROM stock_movements WHERE "productId" = $1`, [p]); return r.rows[0]!.id; });
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'REVERSAL', -4, { cost: 1, total: -4, reversalOf: id }); await holds(tx, A, p, 6); })).rejects.toThrow(/exact opposite/);
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'REVERSAL', -10, { cost: 1, total: -10 }); await holds(tx, A, p, 0); })).rejects.toThrow(/must say which movement/);
    await expect(db.transaction(async (tx) => { await move(tx, A, p, 'ADJUSTMENT', -10, { reversalOf: id }); await holds(tx, A, p, 0); })).rejects.toThrow(/exact opposite/);
    await db.transaction(async (tx) => { await move(tx, A, p, 'REVERSAL', -10, { cost: 1, total: -10, reversalOf: id }); await holds(tx, A, p, 0); });
  });

  it('movements get a strictly increasing order number', async () => {
    const p = (await fresh('Seq')).id;
    await db.transaction(async (tx) => { await move(tx, A, p, 'RECEIPT', 1); await move(tx, A, p, 'RECEIPT', 1); await holds(tx, A, p, 2); });
    const r = await db.query<{ seq: string }>(`SELECT seq::text FROM stock_movements WHERE "productId" = $1 ORDER BY seq`, [p]);
    expect(Number(r.rows[1]!.seq)).toBeGreaterThan(Number(r.rows[0]!.seq));
  });
});


describe('transfer and count rules (Step I)', () => {
  const newLocation = (co: Co) => one<{ id: string }>(`INSERT INTO locations ("companyId", name, code, type) VALUES ($1, $2, $3, 'STORE') RETURNING id`, [co.companyId, `L${next()}`, `L${next()}`]);

  it('a transfer needs two different places of its own company', async () => {
    const second = await newLocation(A);
    const ins = (from: string, to: string) =>
      db.query(`INSERT INTO transfers ("companyId", number, "fromLocationId", "toLocationId", "requestedById") VALUES ($1, $2, $3, $4, $5)`, [A.companyId, `T${next()}`, from, to, uid()]);
    await expect(ins(A.locationId, A.locationId)).rejects.toThrow(/two places of its own company|transfers_distinct_locations/);
    await expect(ins(A.locationId, B.locationId)).rejects.toThrow(/two places of its own company/);
    await ins(A.locationId, second.id);
  });

  it('a count line is consistent: no negatives, and difference is exactly counted minus expected', async () => {
    const c = await one<{ id: string }>(`INSERT INTO stock_counts ("companyId", number, "locationId", "countedAt", "countedById") VALUES ($1, $2, $3, now(), $4) RETURNING id`, [A.companyId, `C${next()}`, A.locationId, uid()]);
    const line = (expected: number, counted: number, diff: number, product = A.productId) =>
      db.query(`INSERT INTO stock_count_lines ("companyId", "countId", "productId", "expectedQty", "countedQty", difference) VALUES ($1, $2, $3, $4, $5, $6)`, [A.companyId, c.id, product, expected, counted, diff]);
    await expect(line(10, 8, -1)).rejects.toThrow(/stock_count_lines_valid/);
    await expect(line(10, -1, -11)).rejects.toThrow(/stock_count_lines_valid/);
    await expect(line(10, 8, -2, B.productId)).rejects.toThrow(/product of its own company/);
    await line(10, 8, -2);
  });

  it('a count must use a place of its own company', async () => {
    await expect(
      db.query(`INSERT INTO stock_counts ("companyId", number, "locationId", "countedAt", "countedById") VALUES ($1, $2, $3, now(), $4)`, [A.companyId, `C${next()}`, B.locationId, uid()]),
    ).rejects.toThrow(/place of its own company/);
  });
});

describe('money account rules (Step K1)', () => {
  const ins = (co: Co, type: string, location: string | null, ledger: string) =>
    db.query(`INSERT INTO financial_accounts ("companyId", name, type, "locationId", "ledgerAccountId") VALUES ($1, $2, $3, $4, $5)`, [co.companyId, `M${next()}`, type, location, ledger]);

  it('a cash drawer needs a place and a bank account must have none', async () => {
    await expect(ins(A, 'CASH', null, A.cash)).rejects.toThrow(/financial_accounts_place_rule/);
    await expect(ins(A, 'BANK', A.locationId, A.cash)).rejects.toThrow(/financial_accounts_place_rule/);
  });

  it('a money account must use an asset account and a place of its own company, and each ledger account only once', async () => {
    await expect(ins(A, 'CASH', A.locationId, B.cash)).rejects.toThrow(/asset account of its own company/);
    await expect(ins(A, 'CASH', A.locationId, A.sales)).rejects.toThrow(/asset account of its own company/);
    await expect(ins(A, 'CASH', B.locationId, A.cash)).rejects.toThrow(/place of its own company/);
    const ledger = await one<{ id: string }>(`INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, $2, 'Drawer', 'ASSET') RETURNING id`, [A.companyId, `9${next()}`]);
    await ins(A, 'CASH', A.locationId, ledger.id);
    await expect(ins(A, 'CASH', A.locationId, ledger.id)).rejects.toThrow(/financial_accounts_ledger_unique|duplicate/);
  });
});


describe('sales rules (Step K2)', () => {
  const unit = (co: Co, productId = co.productId) =>
    one<{ id: string }>(`INSERT INTO product_units ("companyId", "productId", name, "factorToBase", "isBase") VALUES ($1, $2, $3, 2, false) RETURNING id`, [co.companyId, productId, `u${next()}`]);
  const sale = (co: Co, location = co.locationId, customer: string | null = null) =>
    one<{ id: string }>(`INSERT INTO sales ("companyId", number, "locationId", "customerId", subtotal, total, "createdById") VALUES ($1, $2, $3, $4, 10, 10, $5) RETURNING id`, [co.companyId, `S${next()}`, location, customer, uid()]);
  const saleLine = (co: Co, saleId: string, productId: string, unitId: string, qty = 1, price = 10) =>
    db.query(`INSERT INTO sale_lines ("companyId", "saleId", "productId", "productUnitId", quantity, "quantityBase", "unitPrice", "lineTotal") VALUES ($1, $2, $3, $4, $5, $5, $6, 10)`, [co.companyId, saleId, productId, unitId, qty, price]);

  it('a sale uses a place and a customer of its own company', async () => {
    await expect(sale(A, B.locationId)).rejects.toThrow(/place of its own company/);
    const other = await one<{ id: string }>(`INSERT INTO customers ("companyId", code, name) VALUES ($1, $2, 'Other') RETURNING id`, [B.companyId, `C${next()}`]);
    await expect(sale(A, A.locationId, other.id)).rejects.toThrow(/customer of its own company/);
    await sale(A);
  });

  it('a sale line needs a real quantity and price, a product of its own company, and a unit of its own product', async () => {
    const s = await sale(A);
    const u = await unit(A);
    await expect(saleLine(A, s.id, A.productId, u.id, 0)).rejects.toThrow(/sale_lines_valid/);
    await expect(saleLine(A, s.id, A.productId, u.id, 1, -1)).rejects.toThrow(/sale_lines_valid/);
    await expect(saleLine(A, s.id, B.productId, u.id)).rejects.toThrow(/product of its own company/);
    const foreign = await unit(B, B.productId);
    await expect(saleLine(A, s.id, A.productId, foreign.id)).rejects.toThrow(/unit of its own product/);
    await saleLine(A, s.id, A.productId, u.id);
  });

  it('goods are supplied from a place of the same company', async () => {
    const s = await sale(A);
    const u = await unit(A);
    await saleLine(A, s.id, A.productId, u.id);
    const l = await one<{ id: string }>(`SELECT id FROM sale_lines WHERE "saleId" = $1`, [s.id]);
    const alloc = (loc: string) => db.query(`INSERT INTO sale_line_allocations ("companyId", "saleLineId", "supplyLocationId", "qtyBase") VALUES ($1, $2, $3, 1)`, [A.companyId, l.id, loc]);
    await expect(alloc(B.locationId)).rejects.toThrow(/place of its own company/);
    await alloc(A.locationId);
  });

  it('a walk-in payment may have no customer, but a supplier payment still needs a supplier', async () => {
    const fa = await one<{ id: string }>(`INSERT INTO financial_accounts ("companyId", name, type, "locationId", "ledgerAccountId") VALUES ($1, $2, 'CASH', $3, $4) RETURNING id`, [A.companyId, `W${next()}`, A.locationId, (await one<{ id: string }>(`INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, $2, 'Till', 'ASSET') RETURNING id`, [A.companyId, `8${next()}`])).id]);
    const pay = (type: string, amount: number) =>
      db.query(`INSERT INTO payments ("companyId", number, "partyType", "financialAccountId", method, amount, "paidAt", "createdById") VALUES ($1, $2, $3, $4, 'CASH', $5, now(), $6)`, [A.companyId, `PW${next()}`, type, fa.id, amount, uid()]);
    await pay('CUSTOMER', 10);
    await expect(pay('SUPPLIER', 10)).rejects.toThrow(/payments_valid/);
    await expect(pay('CUSTOMER', 0)).rejects.toThrow(/payments_valid/);
  });
});


describe('payment rules (Step L)', () => {
  const customerOf = (co: Co) => one<{ id: string }>(`INSERT INTO customers ("companyId", code, name) VALUES ($1, $2, 'Cust') RETURNING id`, [co.companyId, `C${next()}`]);
  const supplierOf = (co: Co) => one<{ id: string }>(`INSERT INTO suppliers ("companyId", code, name) VALUES ($1, $2, 'Sup') RETURNING id`, [co.companyId, `S${next()}`]);
  const moneyAccount = async (co: Co) => {
    const led = await one<{ id: string }>(`INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, $2, 'Till', 'ASSET') RETURNING id`, [co.companyId, `7${next()}`]);
    return one<{ id: string }>(`INSERT INTO financial_accounts ("companyId", name, type, "locationId", "ledgerAccountId") VALUES ($1, $2, 'CASH', $3, $4) RETURNING id`, [co.companyId, `T${next()}`, co.locationId, led.id]);
  };
  const payment = async (co: Co, party: 'CUSTOMER' | 'SUPPLIER', partyId: string, amount: number) => {
    const fa = await moneyAccount(co);
    return one<{ id: string }>(
      `INSERT INTO payments ("companyId", number, "partyType", "customerId", "supplierId", "financialAccountId", method, amount, "paidAt", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, 'CASH', $7, now(), $8) RETURNING id`,
      [co.companyId, `P${next()}`, party, party === 'CUSTOMER' ? partyId : null, party === 'SUPPLIER' ? partyId : null, fa.id, amount, uid()]);
  };
  const saleOf = (co: Co, customer: string | null) =>
    one<{ id: string }>(`INSERT INTO sales ("companyId", number, "locationId", "customerId", subtotal, total, "createdById") VALUES ($1, $2, $3, $4, 100, 100, $5) RETURNING id`, [co.companyId, `S${next()}`, co.locationId, customer, uid()]);
  const billOf = (co: Co, supplier: string) =>
    one<{ id: string }>(`INSERT INTO purchase_receipts ("companyId", number, "supplierId", "locationId", "receivedAt", "goodsTotal", total, "createdById") VALUES ($1, $2, $3, $4, now(), 100, 100, $5) RETURNING id`, [co.companyId, `R${next()}`, supplier, co.locationId, uid()]);
  const allocate = (co: Co, paymentId: string, target: { saleId?: string; billId?: string }, amount: number) =>
    db.query(`INSERT INTO payment_allocations ("companyId", "paymentId", "saleId", "purchaseReceiptId", amount, "createdById") VALUES ($1, $2, $3, $4, $5, $6)`, [co.companyId, paymentId, target.saleId ?? null, target.billId ?? null, amount, uid()]);

  it('a payment settles only invoices of its own customer, and bills of its own supplier', async () => {
    const c1 = await customerOf(A);
    const c2 = await customerOf(A);
    const pay = await payment(A, 'CUSTOMER', c1.id, 100);
    await expect(allocate(A, pay.id, { saleId: (await saleOf(A, c2.id)).id }, 10)).rejects.toThrow(/invoices of its own customer/);
    await expect(allocate(A, pay.id, { saleId: (await saleOf(A, null)).id }, 10)).rejects.toThrow(/invoices of its own customer/);
    await expect(allocate(A, pay.id, { billId: (await billOf(A, (await supplierOf(A)).id)).id }, 10)).rejects.toThrow(/bills of its own supplier/);
    await allocate(A, pay.id, { saleId: (await saleOf(A, c1.id)).id }, 10);

    const s1 = await supplierOf(A);
    const spay = await payment(A, 'SUPPLIER', s1.id, 100);
    await expect(allocate(A, spay.id, { billId: (await billOf(A, (await supplierOf(A)).id)).id }, 10)).rejects.toThrow(/bills of its own supplier/);
    await expect(allocate(A, spay.id, { saleId: (await saleOf(A, c1.id)).id }, 10)).rejects.toThrow(/invoices of its own customer/);
    await allocate(A, spay.id, { billId: (await billOf(A, s1.id)).id }, 10);
  });

  it('a payment cannot be matched to more than its amount', async () => {
    const c1 = await customerOf(A);
    const pay = await payment(A, 'CUSTOMER', c1.id, 100);
    await allocate(A, pay.id, { saleId: (await saleOf(A, c1.id)).id }, 60);
    await expect(allocate(A, pay.id, { saleId: (await saleOf(A, c1.id)).id }, 41)).rejects.toThrow(/more than its amount/);
    await allocate(A, pay.id, { saleId: (await saleOf(A, c1.id)).id }, 40);
  });

  it('a bill can never be paid more than it is worth', async () => {
    const s1 = await supplierOf(A);
    const bill = await billOf(A, s1.id);
    await db.query(`UPDATE purchase_receipts SET "paidTotal" = 100 WHERE id = $1`, [bill.id]);
    await expect(db.query(`UPDATE purchase_receipts SET "paidTotal" = 100.01 WHERE id = $1`, [bill.id])).rejects.toThrow(/purchase_receipts_paid_valid/);
    await expect(db.query(`UPDATE purchase_receipts SET "paidTotal" = -1 WHERE id = $1`, [bill.id])).rejects.toThrow(/purchase_receipts_paid_valid/);
  });
});

describe('expense and cash movement rules (Step M)', () => {
  const ledgerOf = (co: Co, type = 'ASSET') => one<{ id: string }>(`INSERT INTO accounts ("companyId", code, name, type) VALUES ($1, $2, 'L', $3) RETURNING id`, [co.companyId, `9${next()}`, type]);
  const moneyOf = async (co: Co, location = co.locationId) =>
    one<{ id: string }>(`INSERT INTO financial_accounts ("companyId", name, type, "locationId", "ledgerAccountId") VALUES ($1, $2, 'CASH', $3, $4) RETURNING id`, [co.companyId, `M${next()}`, location, (await ledgerOf(co)).id]);
  const categoryOf = async (co: Co) =>
    one<{ id: string }>(`INSERT INTO expense_categories ("companyId", name, "ledgerAccountId") VALUES ($1, $2, $3) RETURNING id`, [co.companyId, `Cat${next()}`, (await ledgerOf(co, 'EXPENSE')).id]);
  const expense = (co: Co, o: { category: string; account?: string | null; location?: string | null; amount?: number }) =>
    db.query(
      `INSERT INTO expenses ("companyId", number, "locationId", "categoryId", amount, "incurredAt", description, "financialAccountId", "createdById")
       VALUES ($1, $2, $3, $4, $5, now(), 'Fuel', $6, $7)`,
      [co.companyId, `E${next()}`, o.location === undefined ? co.locationId : o.location, o.category, o.amount ?? 10, o.account ?? null, uid()]);
  const transfer = (co: Co, from: string, to: string, extra = '') =>
    db.query(`INSERT INTO funds_transfers ("companyId", number, type, "fromAccountId", "toAccountId", amount, "occurredAt", "createdById"${extra ? ', status, "confirmedAt", "confirmedById"' : ''})
              VALUES ($1, $2, 'TRANSFER', $3, $4, 10, now(), $5${extra ? `, ${extra}` : ''})`, [co.companyId, `T${next()}`, from, to, uid()]);

  it('an expense is for a real amount and uses a category, place and account of its own company', async () => {
    const cat = await categoryOf(A);
    const acct = await moneyOf(A);
    await expense(A, { category: cat.id, account: acct.id });
    await expense(A, { category: cat.id, account: acct.id, location: null }); // a company-wide cost
    await expect(expense(A, { category: cat.id, amount: 0 })).rejects.toThrow(/expenses_valid/);
    await expect(expense(A, { category: (await categoryOf(B)).id })).rejects.toThrow(/category of its own company/);
    await expect(expense(A, { category: cat.id, location: B.locationId })).rejects.toThrow(/place of its own company/);
    await expect(expense(A, { category: cat.id, account: (await moneyOf(B)).id })).rejects.toThrow(/account of its own company/);
  });

  it('a transfer is between two accounts of its own company', async () => {
    const a1 = await moneyOf(A);
    const a2 = await moneyOf(A);
    await transfer(A, a1.id, a2.id);
    await expect(transfer(A, a1.id, (await moneyOf(B)).id)).rejects.toThrow(/two accounts of its own company/);
    await expect(transfer(A, a1.id, a1.id)).rejects.toThrow(/funds_transfers_valid/);
  });

  it('a transfer is confirmed exactly when it says who confirmed it and when', async () => {
    const a1 = await moneyOf(A);
    const a2 = await moneyOf(A);
    await expect(transfer(A, a1.id, a2.id, `'CONFIRMED', NULL, NULL`)).rejects.toThrow(/funds_transfers_state/);
    await expect(transfer(A, a1.id, a2.id, `'PENDING', now(), '${uid()}'`)).rejects.toThrow(/funds_transfers_state/);
    await transfer(A, a1.id, a2.id, `'CONFIRMED', now(), '${uid()}'`);
    await transfer(A, a1.id, a2.id, `'PENDING', NULL, NULL`);
  });
});
