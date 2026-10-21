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
    await balance(A, 20, 5);
    await expect(
      db.query(`UPDATE stock_balances SET committed = 21 WHERE "companyId" = $1`, [A.companyId]),
    ).rejects.toThrow();
  });

  it('stock movements are append-only', async () => {
    await db.query(
      `INSERT INTO stock_movements ("companyId", "locationId", "productId", type, quantity, "refType", "createdById")
       VALUES ($1, $2, $3, 'RECEIPT', 20, 'TEST', $4)`, [A.companyId, A.locationId, A.productId, uid()]);
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
      `INSERT INTO financial_accounts ("companyId", name, type, "ledgerAccountId") VALUES ($1, 'Till A', 'CASH', $2) RETURNING id`,
      [A.companyId, A.cash]);
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
