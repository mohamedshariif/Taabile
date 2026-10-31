import { Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { forbidden } from '../../shared/errors.js';
import { D, ZERO } from '../../shared/money.js';
import { scopeFor, type Permission, type Scope } from '../auth/permissions.js';
import type { OwedQuery, RangeQuery, StockValueQuery } from './reports.schemas.js';

// Reports, in plain words:
//  * They only read. Nothing here changes any data.
//  * Money and quantities come back as text with 4 decimals.
//  * "Day" means the day in the company's own time zone (Africa/Juba unless changed).
//  * Profit and loss and the totals owed come from the accounting ledger or from the documents that feed it.
//    Where both exist, the report shows the ledger figure next to the documents, so a mismatch cannot hide.

const m = (v: string | null | undefined) => D(v ?? '0').toFixed(4);
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function dayContext(tx: Tx, companyId: string) {
  const c = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { timezone: true } });
  const r = await tx.$queryRaw<{ d: string }[]>`SELECT (now() AT TIME ZONE ${c.timezone})::date::text AS d`;
  return { tz: c.timezone, today: r[0]!.d };
}

/** Which rows of a location-based table this person may see, as a SQL piece. */
function placeFilter(auth: AuthContext, scope: Scope, column: Prisma.Sql, ownColumn: Prisma.Sql | null, wanted?: string): Prisma.Sql {
  if (wanted && scope !== 'company' && !auth.locationIds.includes(wanted)) throw forbidden('You can only see your own places');
  const parts: Prisma.Sql[] = [];
  if (scope === 'location') parts.push(Prisma.sql`${column} = ANY(${auth.locationIds}::uuid[])`);
  if (scope === 'own') parts.push(ownColumn ? Prisma.sql`${ownColumn} = ${auth.userId}::uuid` : Prisma.sql`FALSE`);
  if (wanted) parts.push(Prisma.sql`${column} = ${wanted}::uuid`);
  return parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

function need(auth: AuthContext, perm: Permission): Scope {
  const s = scopeFor(auth, perm);
  if (!s) throw forbidden();
  return s;
}

async function ledgerSum(tx: Tx, companyId: string, systemKey: string, sign: 'dc' | 'cd', locationId?: string): Promise<string> {
  const expr = sign === 'dc' ? Prisma.sql`jl.debit - jl.credit` : Prisma.sql`jl.credit - jl.debit`;
  const where = locationId ? Prisma.sql`AND jl."locationId" = ${locationId}::uuid` : Prisma.empty;
  const r = await tx.$queryRaw<{ b: string | null }[]>`
    SELECT SUM(${expr})::numeric(19,4)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId"
    WHERE jl."companyId" = ${companyId}::uuid AND a."systemKey" = ${systemKey} ${where}`;
  return m(r[0]?.b);
}

// ───────────────────────── Sales ─────────────────────────

export async function salesReport(auth: AuthContext, q: RangeQuery) {
  const scope = need(auth, 'reports.view');
  return withTenant(auth, async (tx) => {
    const cid = auth.companyId;
    const { tz, today } = await dayContext(tx, cid);
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -29);
    const filter = placeFilter(auth, scope, Prisma.sql`s."locationId"`, Prisma.sql`s."createdById"`, q.locationId);
    const base = Prisma.sql`s."companyId" = ${cid}::uuid AND s.status = 'POSTED' AND (s."soldAt" AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date ${filter}`;

    const dayRows = await tx.$queryRaw<{ day: string; n: number; total: string; discount: string; paid: string }[]>`
      SELECT (s."soldAt" AT TIME ZONE ${tz})::date::text AS day, count(*)::int AS n, SUM(s.total)::numeric(19,4)::text AS total,
             SUM(s."discountTotal")::numeric(19,4)::text AS discount, SUM(s."paidTotal")::numeric(19,4)::text AS paid
      FROM sales s WHERE ${base} GROUP BY 1 ORDER BY 1`;
    const byDay = new Map(dayRows.map((r) => [r.day, r]));
    const days: { date: string; count: number; total: string; discount: string; paid: string; unpaid: string }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const r = byDay.get(d);
      const total = D(r?.total ?? 0);
      const paid = D(r?.paid ?? 0);
      days.push({ date: d, count: r?.n ?? 0, total: total.toFixed(4), discount: m(r?.discount), paid: paid.toFixed(4), unpaid: total.minus(paid).toFixed(4) });
    }
    let count = 0, total = ZERO, discount = ZERO, paid = ZERO;
    for (const d of days) { count += d.count; total = total.plus(d.total); discount = discount.plus(d.discount); paid = paid.plus(d.paid); }

    const byLocation = await tx.$queryRaw<{ locationId: string; name: string; n: number; total: string }[]>`
      SELECT s."locationId"::text AS "locationId", l.name, count(*)::int AS n, SUM(s.total)::numeric(19,4)::text AS total
      FROM sales s JOIN locations l ON l.id = s."locationId" WHERE ${base} GROUP BY 1, 2 ORDER BY SUM(s.total) DESC`;
    const top = await tx.$queryRaw<{ productId: string; name: string; sku: string; unit: string; qty: string; value: string }[]>`
      SELECT p.id::text AS "productId", p.name, p.sku, p."baseUnit" AS unit, SUM(sl."quantityBase")::numeric(18,4)::text AS qty, SUM(sl."lineTotal")::numeric(19,4)::text AS value
      FROM sale_lines sl JOIN sales s ON s.id = sl."saleId" JOIN products p ON p.id = sl."productId"
      WHERE ${base} GROUP BY 1, 2, 3, 4 ORDER BY SUM(sl."lineTotal") DESC LIMIT 10`;

    return {
      range: { from, to },
      totals: { count, total: total.toFixed(4), discount: discount.toFixed(4), paid: paid.toFixed(4), unpaid: total.minus(paid).toFixed(4), average: count ? total.div(count).toFixed(4) : '0.0000' },
      days,
      byLocation: byLocation.map((r) => ({ locationId: r.locationId, name: r.name, count: r.n, total: m(r.total) })),
      topProducts: top.map((r) => ({ productId: r.productId, name: r.name, sku: r.sku, unit: r.unit, quantity: m(r.qty), value: m(r.value) })),
    };
  });
}

// ───────────────────────── Profit and loss ─────────────────────────

export async function profitLoss(auth: AuthContext, q: RangeQuery) {
  need(auth, 'accounting.view');
  return withTenant(auth, async (tx) => {
    const cid = auth.companyId;
    const { today } = await dayContext(tx, cid);
    const to = q.to ?? today;
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    const place = q.locationId ? Prisma.sql`AND jl."locationId" = ${q.locationId}::uuid` : Prisma.empty;
    const rows = await tx.$queryRaw<{ code: string; name: string; type: 'REVENUE' | 'EXPENSE'; key: string | null; debit: string; credit: string }[]>`
      SELECT a.code, a.name, a.type::text AS type, a."systemKey" AS key, SUM(jl.debit)::numeric(19,4)::text AS debit, SUM(jl.credit)::numeric(19,4)::text AS credit
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl."entryId" JOIN accounts a ON a.id = jl."accountId"
      WHERE jl."companyId" = ${cid}::uuid AND a.type IN ('REVENUE', 'EXPENSE') AND je."entryDate" BETWEEN ${from}::date AND ${to}::date ${place}
      GROUP BY a.id, a.code, a.name, a.type, a."systemKey" ORDER BY a.code`;
    const line = (r: (typeof rows)[number]) => ({ code: r.code, name: r.name, amount: (r.type === 'REVENUE' ? D(r.credit).minus(r.debit) : D(r.debit).minus(r.credit)).toFixed(4) });
    const sum = (ls: { amount: string }[]) => ls.reduce((a, l) => a.plus(l.amount), ZERO);
    const revenue = rows.filter((r) => r.type === 'REVENUE').map(line).filter((l) => !D(l.amount).isZero());
    const cogs = rows.filter((r) => r.key === 'COGS').map(line).filter((l) => !D(l.amount).isZero());
    const expenses = rows.filter((r) => r.type === 'EXPENSE' && r.key !== 'COGS').map(line).filter((l) => !D(l.amount).isZero());
    const revenueTotal = sum(revenue);
    const cogsTotal = sum(cogs);
    const gross = revenueTotal.minus(cogsTotal);
    const expenseTotal = sum(expenses);
    return {
      range: { from, to },
      locationId: q.locationId ?? null,
      revenue, revenueTotal: revenueTotal.toFixed(4),
      costOfGoods: cogs, costOfGoodsTotal: cogsTotal.toFixed(4),
      grossProfit: gross.toFixed(4),
      grossMarginPercent: revenueTotal.isZero() ? null : gross.div(revenueTotal).times(100).toFixed(1),
      expenses, expensesTotal: expenseTotal.toFixed(4),
      netProfit: gross.minus(expenseTotal).toFixed(4),
      /** Costs booked to the whole company (not one place) are left out when a single place is chosen. */
      note: q.locationId ? 'Only entries booked to this place. Company-wide costs are not included.' : null,
    };
  });
}

// ───────────────────────── Stock value ─────────────────────────

export async function stockValue(auth: AuthContext, q: StockValueQuery) {
  need(auth, 'cost.view');
  need(auth, 'stock.view');
  return withTenant(auth, async (tx) => {
    const cid = auth.companyId;
    const place = q.locationId ? Prisma.sql`AND sb."locationId" = ${q.locationId}::uuid` : Prisma.empty;
    const base = Prisma.sql`sb."companyId" = ${cid}::uuid AND sb."onHand" <> 0 ${place}`;
    const byLocation = await tx.$queryRaw<{ locationId: string; name: string; value: string; items: number }[]>`
      SELECT sb."locationId"::text AS "locationId", l.name, SUM(sb."onHand" * sb."avgCost")::numeric(19,4)::text AS value, count(*)::int AS items
      FROM stock_balances sb JOIN locations l ON l.id = sb."locationId" WHERE ${base} GROUP BY 1, 2 ORDER BY SUM(sb."onHand" * sb."avgCost") DESC`;
    const products = await tx.$queryRaw<{ productId: string; name: string; sku: string; unit: string; qty: string; value: string }[]>`
      SELECT p.id::text AS "productId", p.name, p.sku, p."baseUnit" AS unit, SUM(sb."onHand")::numeric(18,4)::text AS qty, SUM(sb."onHand" * sb."avgCost")::numeric(19,4)::text AS value
      FROM stock_balances sb JOIN products p ON p.id = sb."productId" WHERE ${base} GROUP BY 1, 2, 3, 4 ORDER BY SUM(sb."onHand" * sb."avgCost") DESC, p.name LIMIT ${q.limit + 1}`;
    const total = byLocation.reduce((a, r) => a.plus(r.value), ZERO);
    const ledger = await ledgerSum(tx, cid, 'INVENTORY', 'dc', q.locationId);
    const shown = products.slice(0, q.limit);
    return {
      locationId: q.locationId ?? null,
      total: total.toFixed(4),
      /** What the accounting ledger says the stock is worth, and how far it is from the stock list. Should be 0 or a rounding cent. */
      ledgerTotal: ledger,
      difference: total.minus(ledger).toFixed(4),
      byLocation: byLocation.map((r) => ({ locationId: r.locationId, name: r.name, items: r.items, value: m(r.value) })),
      products: shown.map((r) => {
        const qty = D(r.qty);
        return { productId: r.productId, name: r.name, sku: r.sku, unit: r.unit, quantity: qty.toFixed(4), averageCost: qty.isZero() ? '0.0000' : D(r.value).div(qty).toFixed(4), value: m(r.value) };
      }),
      truncated: products.length > q.limit,
    };
  });
}

// ───────────────────────── Who owes us / whom we owe ─────────────────────────

const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

async function owed(auth: AuthContext, q: OwedQuery, kind: 'customers' | 'suppliers') {
  const scope = need(auth, 'payments.view');
  return withTenant(auth, async (tx) => {
    const cid = auth.companyId;
    const { tz, today } = await dayContext(tx, cid);
    const isC = kind === 'customers';
    const table = isC ? Prisma.sql`sales` : Prisma.sql`purchase_receipts`;
    const party = isC ? Prisma.sql`customers` : Prisma.sql`suppliers`;
    const partyCol = isC ? Prisma.sql`d."customerId"` : Prisma.sql`d."supplierId"`;
    const dateCol = isC ? Prisma.sql`d."soldAt"` : Prisma.sql`d."receivedAt"`;
    const filter = placeFilter(auth, scope, Prisma.sql`d."locationId"`, null, q.locationId);
    const age = Prisma.sql`(${today}::date - COALESCE(d."dueDate", (${dateCol} AT TIME ZONE ${tz})::date))`;
    const open = Prisma.sql`(d.total - d."paidTotal")`;
    const rows = await tx.$queryRaw<{ id: string; code: string; name: string; phone: string | null; n: number; owed: string; b0: string; b1: string; b2: string; b3: string; b4: string; oldest: number }[]>`
      SELECT p.id::text AS id, p.code, p.name, p.phone, count(*)::int AS n, SUM(${open})::numeric(19,4)::text AS owed,
        SUM(CASE WHEN ${age} <= 0 THEN ${open} ELSE 0 END)::numeric(19,4)::text AS b0,
        SUM(CASE WHEN ${age} BETWEEN 1 AND 30 THEN ${open} ELSE 0 END)::numeric(19,4)::text AS b1,
        SUM(CASE WHEN ${age} BETWEEN 31 AND 60 THEN ${open} ELSE 0 END)::numeric(19,4)::text AS b2,
        SUM(CASE WHEN ${age} BETWEEN 61 AND 90 THEN ${open} ELSE 0 END)::numeric(19,4)::text AS b3,
        SUM(CASE WHEN ${age} > 90 THEN ${open} ELSE 0 END)::numeric(19,4)::text AS b4,
        GREATEST(MAX(${age}), 0)::int AS oldest
      FROM ${table} d JOIN ${party} p ON p.id = ${partyCol}
      WHERE d."companyId" = ${cid}::uuid AND d.status = 'POSTED' AND d.total > d."paidTotal" ${filter}
      GROUP BY p.id, p.code, p.name, p.phone ORDER BY SUM(${open}) DESC, p.name`;
    const sums = BUCKETS.map((_, i) => rows.reduce((a, r) => a.plus((r as unknown as Record<string, string>)[`b${i}`]!), ZERO));
    const total = rows.reduce((a, r) => a.plus(r.owed), ZERO);
    // Only a company-wide view can be compared with the whole ledger.
    const ledgerTotal = scope === 'company' && !q.locationId ? await ledgerSum(tx, cid, isC ? 'AR_CUSTOMERS' : 'AP_SUPPLIERS', isC ? 'dc' : 'cd') : null;
    return {
      asOf: today,
      locationId: q.locationId ?? null,
      total: total.toFixed(4),
      buckets: Object.fromEntries(BUCKETS.map((b, i) => [b, sums[i]!.toFixed(4)])) as Record<(typeof BUCKETS)[number], string>,
      /** What the ledger says, and how far it is from the open documents. Should be 0. */
      ledgerTotal,
      difference: ledgerTotal === null ? null : total.minus(ledgerTotal).toFixed(4),
      parties: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, phone: r.phone, openDocuments: r.n, owed: m(r.owed),
        notDue: m(r.b0), days1to30: m(r.b1), days31to60: m(r.b2), days61to90: m(r.b3), over90: m(r.b4), oldestDaysOverdue: r.oldest,
      })),
    };
  });
}

export const receivables = (auth: AuthContext, q: OwedQuery) => owed(auth, q, 'customers');
export const payables = (auth: AuthContext, q: OwedQuery) => owed(auth, q, 'suppliers');

// ───────────────────────── Overview ─────────────────────────

/** The few numbers an owner looks at first. A figure the person has no right to see comes back as null. */
export async function overview(auth: AuthContext) {
  need(auth, 'reports.view');
  const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
  const salesNow = await salesReport(auth, {});
  const today = salesNow.range.to;
  const todayRow = salesNow.days.find((d) => d.date === today);
  const month = await salesReport(auth, { from: monthOf(today), to: today });
  const tryRun = async <T>(perm: Permission, fn: () => Promise<T>): Promise<T | null> => (scopeFor(auth, perm) ? fn() : null);
  const owedToUs = await tryRun('payments.view', () => receivables(auth, {}));
  const weOwe = await tryRun('payments.view', () => payables(auth, {}));
  const stock = scopeFor(auth, 'cost.view') && scopeFor(auth, 'stock.view') ? await stockValue(auth, { limit: 1 }) : null;
  const cash =
    scopeFor(auth, 'cash.manage') === 'company'
      ? await withTenant(auth, async (tx) => {
          const r = await tx.$queryRaw<{ b: string | null }[]>`
            SELECT SUM(jl.debit - jl.credit)::numeric(19,4)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId"
            JOIN accounts p ON p.id = a."parentId" WHERE jl."companyId" = ${auth.companyId}::uuid AND p."systemKey" IN ('CASH_ROOT', 'BANK_ROOT')`;
          return m(r[0]?.b);
        })
      : null;
  return {
    asOf: today,
    salesToday: { count: todayRow?.count ?? 0, total: todayRow?.total ?? '0.0000' },
    salesThisMonth: { count: month.totals.count, total: month.totals.total },
    owedToUs: owedToUs?.total ?? null,
    weOwe: weOwe?.total ?? null,
    stockValue: stock?.total ?? null,
    cashAndBank: cash,
  };
}