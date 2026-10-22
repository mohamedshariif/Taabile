import type { Tx } from '../db/client.js';

/** Table names people never see: shown in plain words when we explain why something cannot be deleted. */
const WORDS: Record<string, string> = {
  stock_movements: 'stock movements',
  stock_balances: 'stock balances',
  purchase_receipt_lines: 'purchases',
  sale_lines: 'sales',
  sale_return_lines: 'sale returns',
  transfer_lines: 'transfers',
  stock_count_lines: 'stock counts',
  journal_lines: 'accounting entries',
  sales: 'sales',
  payments: 'payments',
  expenses: 'expenses',
  products: 'products',
  customers: 'customers',
};

const plain = (table: string) => WORDS[table] ?? table.replace(/_/g, ' ');

export interface Reference {
  table: string;
  count: number;
}

/**
 * Everything that still points at one record, found from the database's own list of foreign keys,
 * so a table added in a later step is covered automatically. `ignore` lists tables that belong to the
 * record itself (a product's own units and prices) and are removed together with it.
 * Used to answer "was this record ever used?" before a mistaken record is deleted.
 */
export async function referencesTo(tx: Tx, table: string, id: string, ignore: string[] = []): Promise<Reference[]> {
  const fks = await tx.$queryRaw<{ child: string; col: string }[]>`
    SELECT cl.relname::text AS child, a.attname::text AS col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = ${table}::regclass`;
  const found: Reference[] = [];
  for (const fk of fks) {
    if (ignore.includes(fk.child)) continue;
    // Identifiers come from the database catalog (never from a request); the id is a bound parameter.
    const quote = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ${quote(fk.child)} WHERE ${quote(fk.col)} = $1::uuid`,
      id,
    );
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) found.push({ table: fk.child, count: n });
  }
  return found;
}

/** "purchases: 3, stock movements: 12" (alphabetical, so the message is always the same) */
export const describeReferences = (refs: Reference[]): string =>
  refs
    .map((r) => ({ name: plain(r.table), count: r.count }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => `${r.name}: ${r.count}`)
    .join(', ');