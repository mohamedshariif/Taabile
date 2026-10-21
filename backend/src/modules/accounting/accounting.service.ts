import { withTenant, type Tx } from '../../db/client.js';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { D } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { fromDateOnly, toDateOnly } from '../../shared/schemas.js';
import { assertLocationsExist } from '../locations/locations.service.js';
import type { ManualJournalInput, ReverseJournalInput } from './accounting.schemas.js';

export async function listAccounts(auth: AuthContext) {
  const rows = await withTenant(auth, (tx) =>
    tx.account.findMany({ where: { companyId: auth.companyId }, orderBy: { code: 'asc' } }),
  );
  return {
    accounts: rows.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      isPostable: a.isPostable,
      status: a.status,
    })),
  };
}

export async function listPeriods(auth: AuthContext, year?: number) {
  const rows = await withTenant(auth, (tx) =>
    tx.accountingPeriod.findMany({
      where: { companyId: auth.companyId, ...(year ? { year } : {}) },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    }),
  );
  return {
    periods: rows.map((p) => ({ id: p.id, year: p.year, month: p.month, status: p.status, lockedAt: p.lockedAt })),
  };
}

async function setPeriodStatus(auth: AuthContext, id: string, to: 'LOCKED' | 'OPEN', ip?: string) {
  return withTenant(auth, async (tx) => {
    const p = await tx.accountingPeriod.findFirst({ where: { id, companyId: auth.companyId } });
    if (!p) throw notFound('Period not found');
    if (p.status === to) throw conflict(to === 'LOCKED' ? 'This period is already locked' : 'This period is already open');
    const updated = await tx.accountingPeriod.update({
      where: { id },
      data: to === 'LOCKED' ? { status: 'LOCKED', lockedAt: new Date(), lockedById: auth.userId } : { status: 'OPEN', lockedAt: null, lockedById: null },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: to === 'LOCKED' ? 'period.locked' : 'period.reopened',
      entityType: 'accounting_period',
      entityId: id,
      before: { status: p.status },
      after: { status: updated.status, year: p.year, month: p.month },
      ip,
    });
    return { period: { id, year: p.year, month: p.month, status: updated.status, lockedAt: updated.lockedAt } };
  });
}
export const lockPeriod = (a: AuthContext, id: string, ip?: string) => setPeriodStatus(a, id, 'LOCKED', ip);
export const reopenPeriod = (a: AuthContext, id: string, ip?: string) => setPeriodStatus(a, id, 'OPEN', ip);

type EntryWithLines = Awaited<ReturnType<typeof loadEntries>>[number];

function loadEntries(tx: Tx, where: object, extra: object = {}) {
  return tx.journalEntry.findMany({
    where,
    include: {
      journalLines: { include: { account: { select: { code: true, name: true } } }, orderBy: { id: 'asc' } },
      reversedBy: { select: { id: true, number: true } },
    },
    ...extra,
  });
}

const presentEntry = (e: EntryWithLines) => ({
  id: e.id,
  number: e.number,
  entryDate: fromDateOnly(e.entryDate),
  description: e.description,
  sourceType: e.sourceType,
  isManual: e.isManual,
  createdAt: e.createdAt,
  reversalOfId: e.reversalOfId,
  reversedBy: e.reversedBy,
  // Lines have no natural order in the database, so show debits first, then credits, by account code.
  lines: [...e.journalLines]
    .sort((x, y) => Number(y.debit.gt(0)) - Number(x.debit.gt(0)) || x.account.code.localeCompare(y.account.code))
    .map((l) => ({
    accountId: l.accountId,
    accountCode: l.account.code,
    accountName: l.account.name,
    debit: l.debit.toFixed(4),
    credit: l.credit.toFixed(4),
    locationId: l.locationId,
    memo: l.memo,
  })),
});

export async function listJournals(auth: AuthContext, q: { limit: number; cursor?: string; from?: string; to?: string }) {
  return withTenant(auth, async (tx) => {
    const rows = await loadEntries(
      tx,
      {
        companyId: auth.companyId,
        ...(q.from || q.to
          ? { entryDate: { ...(q.from ? { gte: toDateOnly(q.from) } : {}), ...(q.to ? { lte: toDateOnly(q.to) } : {}) } }
          : {}),
      },
      { orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(q) },
    );
    const page = toPage(rows, q.limit);
    return { items: page.items.map(presentEntry), nextCursor: page.nextCursor };
  });
}

export async function getJournal(auth: AuthContext, id: string) {
  return withTenant(auth, async (tx) => {
    const [e] = await loadEntries(tx, { id, companyId: auth.companyId });
    if (!e) throw notFound('Journal entry not found');
    return { entry: presentEntry(e) };
  });
}

export async function postManualJournal(auth: AuthContext, input: ManualJournalInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    await assertLocationsExist(tx, auth.companyId, input.lines.flatMap((l) => (l.locationId ? [l.locationId] : [])));
    const posted = await postJournal(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      entryDate: toDateOnly(input.entryDate),
      isManual: true,
      draft: {
        sourceType: 'manual',
        description: input.description,
        lines: input.lines.map((l) => ({
          account: { id: l.accountId },
          debit: D(l.debit),
          credit: D(l.credit),
          locationId: l.locationId ?? null,
          memo: l.memo,
        })),
      },
    });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'journal.posted',
      entityType: 'journal_entry',
      entityId: posted.id,
      after: { number: posted.number, description: input.description },
      ip,
    });
    const [e] = await loadEntries(tx, { id: posted.id, companyId: auth.companyId });
    return { entry: presentEntry(e!) };
  });
}

export async function reverseEntry(auth: AuthContext, id: string, input: ReverseJournalInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const date = input.date ?? fromDateOnly(new Date());
    const posted = await reverseJournal(tx, auth, id, { date: toDateOnly(date), reason: input.reason });
    if (!posted.created) throw badRequest('This entry was already reversed');
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'journal.reversed',
      entityType: 'journal_entry',
      entityId: id,
      after: { reversalId: posted.id, reversalNumber: posted.number, reason: input.reason },
      ip,
    });
    const [e] = await loadEntries(tx, { id: posted.id, companyId: auth.companyId });
    return { entry: presentEntry(e!) };
  });
}