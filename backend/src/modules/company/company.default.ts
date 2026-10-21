/* Everything a new company needs before it can record anything: the 27 accounts, 6 expense categories linked to their accounts, Retail and Wholesale price lists, and 12 accounting months. It only adds what is missing, so it is safe to run twice. */

import type { Tx } from '../../db/client.js';
import { DEFAULT_CHART, DEFAULT_EXPENSE_CATEGORIES } from '../../accounting/chart.js';

export async function seedCompanyDefaults(tx: Tx, companyId: string, now = new Date()): Promise<void> {
  // 1. Chart of accounts
  await tx.account.createMany({
    data: DEFAULT_CHART.map((a) => ({
      companyId,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      isPostable: a.isPostable,
    })),
    skipDuplicates: true,
  });

  // 2. Expense categories -> the account they post to
  const accounts = await tx.account.findMany({ where: { companyId }, select: { id: true, systemKey: true } });
  const idByKey = new Map(accounts.map((a) => [a.systemKey, a.id]));
  await tx.expenseCategory.createMany({
    data: DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
      companyId,
      name: c.name,
      ledgerAccountId: idByKey.get(c.systemKey)!,
    })),
    skipDuplicates: true,
  });

  // 3. Price lists. Retail is the default; the Admin can change that later.
  const haveLists = await tx.priceList.count({ where: { companyId } });
  if (haveLists === 0) {
    await tx.priceList.createMany({
      data: [
        { companyId, name: 'Retail', kind: 'RETAIL', isDefault: true },
        { companyId, name: 'Wholesale', kind: 'WHOLESALE', isDefault: false },
      ],
    });
  }

  // 4. Accounting periods: 12 months of the current year. Other months are created on demand when first posted into.
  const year = now.getUTCFullYear();
  await tx.accountingPeriod.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({ companyId, year, month: i + 1 })),
    skipDuplicates: true,
  });
}