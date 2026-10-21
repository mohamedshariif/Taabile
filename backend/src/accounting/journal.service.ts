import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/client.js';
import { nextDocumentNumber } from '../shared/documentNumber.js';
import { AppError, badRequest, conflict, notFound } from '../shared/errors.js';
import { D } from '../shared/money.js';
import { assertBalanced, postingKey, reverse, type JournalDraft } from './posting.js';

export interface PostArgs {
  companyId: string;
  userId: string;
  draft: JournalDraft;
  entryDate: Date; // a calendar date at 00:00 UTC
  /** The document this entry belongs to (a sale id...). Together with `event` it forms the unique posting key. */
  sourceId?: string | null;
  event?: string;
  isManual?: boolean;
  /** Set only when reversing another entry. */
  reversalOfId?: string;
  postingKeyOverride?: string;
}

export interface PostResult {
  id: string;
  number: string;
  /** false when the same event had already been posted: the earlier entry is returned and nothing new is written. */
  created: boolean;
}

/** Finds the accounting period (month) for a date, creating it when it does not exist yet. A LOCKED period refuses entries. */
export async function ensurePeriod(tx: Tx, companyId: string, date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  await tx.accountingPeriod.createMany({ data: [{ companyId, year, month }], skipDuplicates: true });
  const period = await tx.accountingPeriod.findUniqueOrThrow({
    where: { companyId_year_month: { companyId, year, month } },
  });
  if (period.status === 'LOCKED') {
    throw new AppError(409, 'PERIOD_LOCKED', `The accounting period ${year}-${String(month).padStart(2, '0')} is locked`);
  }
  return period;
}

export async function postJournal(tx: Tx, a: PostArgs): Promise<PostResult> {
  const key =
    a.postingKeyOverride ?? postingKey(a.draft.sourceType, a.sourceId ?? `manual-${randomUUID()}`, a.event ?? 'post');

  // Posting the same event twice returns the first entry (safe retry).
  const existing = await tx.journalEntry.findUnique({
    where: { companyId_postingKey: { companyId: a.companyId, postingKey: key } },
    select: { id: true, number: true },
  });
  if (existing) return { ...existing, created: false };

  try {
    assertBalanced(a.draft);
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : 'The journal is not balanced');
  }

  // Turn "account selectors" (a system key such as INVENTORY, or an explicit id) into real account ids.
  const keys = a.draft.lines.flatMap((l) => ('key' in l.account ? [l.account.key] : []));
  const ids = a.draft.lines.flatMap((l) => ('id' in l.account ? [l.account.id] : []));
  const accounts = await tx.account.findMany({
    where: { companyId: a.companyId, OR: [{ systemKey: { in: keys } }, { id: { in: ids } }] },
  });
  const byKey = new Map(accounts.map((x) => [x.systemKey, x]));
  const byId = new Map(accounts.map((x) => [x.id, x]));
  const resolved = a.draft.lines.map((l) => {
    const acc = 'key' in l.account ? byKey.get(l.account.key) : byId.get(l.account.id);
    if (!acc) throw badRequest(`Account not found: ${'key' in l.account ? l.account.key : l.account.id}`);
    // A reversal must still work if an account was switched off after the original entry.
    if (!a.reversalOfId) {
      if (!acc.isPostable) throw badRequest(`Account ${acc.code} ${acc.name} is a group account and cannot be posted to`);
      if (acc.status !== 'ACTIVE') throw badRequest(`Account ${acc.code} ${acc.name} is inactive`);
    }
    return { acc, line: l };
  });

  const period = await ensurePeriod(tx, a.companyId, a.entryDate);
  const number = await nextDocumentNumber(tx, a.companyId, 'JE');

  const entry = await tx.journalEntry.create({
    data: {
      companyId: a.companyId,
      number,
      entryDate: a.entryDate,
      periodId: period.id,
      description: a.draft.description,
      sourceType: a.draft.sourceType,
      sourceId: a.sourceId ?? null,
      postingKey: key,
      isManual: a.isManual ?? false,
      createdById: a.userId,
      reversalOfId: a.reversalOfId ?? null,
    },
    select: { id: true, number: true },
  });
  await tx.journalLine.createMany({
    data: resolved.map(({ acc, line }) => ({
      companyId: a.companyId,
      entryId: entry.id,
      accountId: acc.id,
      debit: line.debit.toString(),
      credit: line.credit.toString(),
      locationId: line.locationId ?? null,
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
      employeeId: line.employeeId ?? null,
      memo: line.memo ?? null,
    })),
  });
  // The database re-checks "debits equal credits" when the transaction commits (deferred trigger).
  return { ...entry, created: true };
}

/** Posts the mirror image of an entry (debit and credit swapped). The original is never touched. */
export async function reverseJournal(
  tx: Tx,
  ctx: { companyId: string; userId: string },
  entryId: string,
  opts: { date: Date; reason: string },
): Promise<PostResult> {
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId: ctx.companyId },
    include: { journalLines: true, reversedBy: { select: { id: true } } },
  });
  if (!original) throw notFound('Journal entry not found');
  if (original.reversalOfId) throw badRequest('A reversal cannot be reversed again. Post a new entry instead.');
  if (original.reversedBy) throw conflict('This entry has already been reversed');

  const mirror = reverse({
    sourceType: original.sourceType,
    description: `${original.number}: ${original.description}`,
    lines: original.journalLines.map((l) => ({
      account: { id: l.accountId },
      debit: D(l.debit.toString()),
      credit: D(l.credit.toString()),
      locationId: l.locationId,
      customerId: l.customerId,
      supplierId: l.supplierId,
      employeeId: l.employeeId,
      memo: l.memo ?? undefined,
    })),
  });
  mirror.description = `Reversal of ${original.number}: ${opts.reason}`;

  return postJournal(tx, {
    companyId: ctx.companyId,
    userId: ctx.userId,
    draft: mirror,
    entryDate: opts.date,
    sourceId: original.sourceId,
    isManual: true,
    reversalOfId: original.id,
    postingKeyOverride: `reversal:${original.id}`,
  });
}