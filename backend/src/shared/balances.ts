import type { Tx } from '../db/client.js';

// What a customer owes us / what we owe a supplier, read from the accounting ledger (the single source of truth).
// A customer's balance is debits minus credits on the "Accounts receivable" account; a supplier's is credits minus
// debits on "Accounts payable". Positive = money still owed. Returned as text, never as a JavaScript number.

async function sumBy(tx: Tx, companyId: string, column: 'customerId' | 'supplierId', systemKey: string, sign: 'dc' | 'cd', ids: string[]) {
  const out = new Map<string, string>(ids.map((id) => [id, '0.0000']));
  if (ids.length === 0) return out;
  // `column` and `sign` are fixed words chosen in this file, never user input.
  const rows = await tx.$queryRawUnsafe<{ id: string; bal: string }[]>(
    `SELECT jl."${column}"::text AS id, SUM(${sign === 'dc' ? 'jl.debit - jl.credit' : 'jl.credit - jl.debit'})::numeric(19,4)::text AS bal
     FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId"
     WHERE jl."companyId" = $1::uuid AND a."systemKey" = $2 AND jl."${column}" = ANY($3::uuid[])
     GROUP BY 1`,
    companyId,
    systemKey,
    ids,
  );
  for (const r of rows) out.set(r.id, r.bal);
  return out;
}

export const customerBalances = (tx: Tx, companyId: string, ids: string[]) => sumBy(tx, companyId, 'customerId', 'AR_CUSTOMERS', 'dc', ids);
export const supplierBalances = (tx: Tx, companyId: string, ids: string[]) => sumBy(tx, companyId, 'supplierId', 'AP_SUPPLIERS', 'cd', ids);