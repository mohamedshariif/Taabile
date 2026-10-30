import type { Decimal } from 'decimal.js';
import type { Tx } from '../db/client.js';
import { D } from './money.js';

/**
 * What a cash drawer or bank account holds, read from the ledger.
 * Call lockMoneyAccount first when the balance decides whether money may leave, so two people spending at the same
 * moment cannot both spend the same money.
 */
export async function moneyAccountBalance(tx: Tx, companyId: string, ledgerAccountId: string): Promise<Decimal> {
  const r = await tx.$queryRaw<{ b: string | null }[]>`SELECT SUM(debit - credit)::numeric(19,4)::text AS b FROM journal_lines WHERE "companyId" = ${companyId}::uuid AND "accountId" = ${ledgerAccountId}::uuid`;
  return D(r[0]?.b ?? '0');
}

export async function lockMoneyAccount(tx: Tx, financialAccountId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM financial_accounts WHERE id = ${financialAccountId}::uuid FOR UPDATE`;
}