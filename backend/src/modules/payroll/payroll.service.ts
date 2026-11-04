import { Prisma } from '@prisma/client';
import type { Decimal } from 'decimal.js';
import { postJournal, reverseJournal } from '../../accounting/journal.service.js';
import * as posting from '../../accounting/posting.js';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { lockMoneyAccount, moneyAccountBalance } from '../../shared/cashAccounts.js';
import { nextDocumentNumber } from '../../shared/documentNumber.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { D, ZERO } from '../../shared/money.js';
import { pageArgs, toPage } from '../../shared/pagination.js';
import { fromDateOnly, toDateOnly } from '../../shared/schemas.js';
import { scopeFor } from '../auth/permissions.js';
import type { AdjustInput, CreateEmployeeInput, EmployeeListQuery, PayInput, SalaryInput, UpdateEmployeeInput } from './payroll.schemas.js';

// Employees and payroll, in plain words:
//  * What the company owes an employee is read from the accounting books (the "amounts owed to employees" account).
//    A plus number means the company owes them. A minus number means they owe the company (an advance not yet earned).
//  * Posting the month's salaries adds to what is owed. Paying salary or giving an advance takes money from a drawer or bank.
//  * Nothing is edited. A mistake is cancelled (voided) with a reason, or corrected with an adjustment.
//  * Only people with payroll permissions can see any of this, because pay is private.

const today = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const m = (v: { toString(): string }) => D(v.toString()).toFixed(4);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const lastDayOf = (period: string) => {
  const [y, mo] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0));
};

function mustSee(auth: AuthContext) {
  if (!scopeFor(auth, 'payroll.view')) throw forbidden();
}
function mustManage(auth: AuthContext) {
  if (!scopeFor(auth, 'payroll.manage')) throw forbidden();
}

// ───────────────────────── Balances and salaries ─────────────────────────

/** What the company owes each employee (plus = we owe them), from the ledger. One employee, or everyone. */
async function balances(tx: Tx, companyId: string, employeeId?: string): Promise<Map<string, Decimal>> {
  const only = employeeId ? Prisma.sql`AND jl."employeeId" = ${employeeId}::uuid` : Prisma.empty;
  const rows = await tx.$queryRaw<{ id: string; b: string }[]>`
    SELECT jl."employeeId"::text AS id, SUM(jl.credit - jl.debit)::numeric(19,4)::text AS b
    FROM journal_lines jl JOIN accounts a ON a.id = jl."accountId"
    WHERE jl."companyId" = ${companyId}::uuid AND a."systemKey" = 'EMPLOYEE_PAYABLE' AND jl."employeeId" IS NOT NULL ${only}
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.id, D(r.b)]));
}

interface Agreement { id: string; monthlyAmount: { toString(): string }; effectiveFrom: Date; endedOn: Date | null }
/** The pay that applies on a given day, if any. */
function inForce(list: Agreement[], on: Date): Agreement | undefined {
  return list.filter((a) => a.effectiveFrom <= on && (a.endedOn === null || a.endedOn >= on)).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}

const empInclude = {
  location: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
  salaryAgreements: { orderBy: { effectiveFrom: 'desc' } },
} satisfies Prisma.EmployeeInclude;
type EmpRow = Prisma.EmployeeGetPayload<{ include: typeof empInclude }>;

const presentEmployee = (e: EmpRow, balance: Decimal) => ({
  id: e.id,
  name: e.name,
  phone: e.phone,
  position: e.position,
  location: e.location,
  status: e.status,
  startedOn: e.startedOn ? fromDateOnly(e.startedOn) : null,
  /** The login this person uses, if any. */
  linkedUser: e.user,
  /** The monthly pay in force today (null when none is set). */
  salary: ((a) => (a ? m(a.monthlyAmount) : null))(inForce(e.salaryAgreements, today())),
  /** Plus: the company owes this person. Minus: this person owes the company. */
  balance: balance.toFixed(4),
});

// ───────────────────────── Employees ─────────────────────────

export async function listEmployees(auth: AuthContext, f: EmployeeListQuery) {
  mustSee(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const where: Prisma.EmployeeWhereInput = {
      companyId,
      ...(f.status ? { status: f.status } : {}),
      ...(f.locationId ? { locationId: f.locationId } : {}),
      ...(f.payNotSet ? { salaryAgreements: { none: { effectiveFrom: { lte: today() }, OR: [{ endedOn: null }, { endedOn: { gte: today() } }] } } } : {}),
      ...(f.search ? { OR: [{ name: { contains: f.search, mode: 'insensitive' } }, { position: { contains: f.search, mode: 'insensitive' } }, { phone: { contains: f.search } }] } : {}),
    };
    const rows = await tx.employee.findMany({ where, include: empInclude, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...pageArgs(f) });
    const bal = await balances(tx, companyId);
    const page = toPage(rows, f.limit);
    // Company-wide figures (not limited by the filter).
    let owedToEmployees = ZERO;
    let owedByEmployees = ZERO;
    for (const b of bal.values()) (b.gt(0) ? (owedToEmployees = owedToEmployees.plus(b)) : (owedByEmployees = owedByEmployees.plus(b.abs())));
    const active = await tx.employee.findMany({ where: { companyId, status: 'ACTIVE' }, include: { salaryAgreements: true } });
    const monthlyPayroll = active.reduce((s, e) => s.plus(inForce(e.salaryAgreements, today())?.monthlyAmount.toString() ?? 0), ZERO);
    const payNotSetCount = active.filter((e) => !inForce(e.salaryAgreements, today())).length;
    return {
      items: page.items.map((e) => presentEmployee(e, bal.get(e.id) ?? ZERO)),
      nextCursor: page.nextCursor,
      totals: { owedToEmployees: owedToEmployees.toFixed(4), owedByEmployees: owedByEmployees.toFixed(4), monthlyPayroll: monthlyPayroll.toFixed(4), activeCount: active.length, payNotSetCount },
    };
  });
}

async function loadEmployee(tx: Tx, companyId: string, id: string) {
  const e = await tx.employee.findFirst({ where: { id, companyId }, include: empInclude });
  if (!e) throw notFound('Employee not found');
  const bal = await balances(tx, companyId, id);
  return {
    employee: {
      ...presentEmployee(e, bal.get(id) ?? ZERO),
      salaryHistory: e.salaryAgreements.map((a) => ({ id: a.id, monthlyAmount: m(a.monthlyAmount), effectiveFrom: fromDateOnly(a.effectiveFrom), endedOn: a.endedOn ? fromDateOnly(a.endedOn) : null })),
    },
  };
}

export async function getEmployee(auth: AuthContext, id: string) {
  mustSee(auth);
  return withTenant(auth, (tx) => loadEmployee(tx, auth.companyId, id));
}

async function checkPlace(tx: Tx, companyId: string, locationId: string) {
  const loc = await tx.location.findFirst({ where: { id: locationId, companyId }, select: { name: true, status: true } });
  if (!loc) throw notFound('Location not found');
  if (loc.status !== 'ACTIVE') throw badRequest(`"${loc.name}" is switched off`);
}

async function checkNameFree(tx: Tx, companyId: string, name: string, exceptId?: string) {
  const same = await tx.employee.findFirst({ where: { companyId, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (same) throw conflict(`There is already an employee called "${name}". Add something to tell them apart (for example the position).`);
}

/** A login can be linked when it is an active member of THIS company and no other employee uses it yet. */
async function checkLogin(tx: Tx, companyId: string, userId: string, exceptEmployeeId?: string) {
  const member = await tx.membership.findFirst({ where: { companyId, userId }, select: { status: true, user: { select: { name: true } } } });
  if (!member) throw badRequest('That login is not a member of this company');
  if (member.status !== 'ACTIVE') throw badRequest(`${member.user.name}'s login is switched off`);
  const used = await tx.employee.findFirst({ where: { companyId, userId, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) }, select: { name: true } });
  if (used) throw conflict(`That login is already linked to ${used.name}`);
}
/** The unique rule also covers other companies, which this company cannot see: say it without naming anyone. */
const loginTaken = (err: unknown) => {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('That login is already linked to an employee');
  throw err;
};

/** Logins of this company that can still be linked to an employee (the one already linked to `employeeId` stays in the list). */
export async function linkableUsers(auth: AuthContext, employeeId?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    const members = await tx.membership.findMany({ where: { companyId, status: 'ACTIVE' }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
    const used = await tx.employee.findMany({ where: { companyId, userId: { not: null }, ...(employeeId ? { id: { not: employeeId } } : {}) }, select: { userId: true } });
    const taken = new Set(used.map((u) => u.userId));
    return { users: members.filter((x) => !taken.has(x.userId)).map((x) => ({ userId: x.userId, name: x.user.name, email: x.user.email, role: x.role })) };
  });
}

export async function createEmployee(auth: AuthContext, input: CreateEmployeeInput, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await checkNameFree(tx, companyId, input.name);
    if (input.locationId) await checkPlace(tx, companyId, input.locationId);
    if (input.userId) await checkLogin(tx, companyId, input.userId);
    const e = await tx.employee.create({
      data: {
        companyId, name: input.name, phone: input.phone ?? null, position: input.position ?? null, locationId: input.locationId ?? null,
        startedOn: input.startedOn ? toDateOnly(input.startedOn) : null,
        userId: input.userId ?? null,
      },
      select: { id: true },
    }).catch(loginTaken);
    if (input.monthlyAmount) {
      const from = input.salaryFrom ?? input.startedOn ?? fromDateOnly(today());
      await tx.salaryAgreement.create({ data: { companyId, employeeId: e.id, monthlyAmount: D(input.monthlyAmount).toString(), effectiveFrom: toDateOnly(from) } });
    }
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'employee.created',
      entityType: 'employee',
      entityId: e.id,
      after: {
        name: input.name,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.monthlyAmount
          ? { monthlyAmount: D(input.monthlyAmount).toFixed(2) }
          : {})
      },
      ip
    });
    return loadEmployee(tx, companyId, e.id);
  });
}

export async function updateEmployee(auth: AuthContext, id: string, input: UpdateEmployeeInput, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${id}::uuid FOR UPDATE`;
    const e = await tx.employee.findFirst({ where: { id, companyId } });
    if (!e) throw notFound('Employee not found');
    if (input.name && input.name.toLowerCase() !== e.name.toLowerCase()) await checkNameFree(tx, companyId, input.name, id);
    if (input.locationId) await checkPlace(tx, companyId, input.locationId);
    // Salaries already posted stay valid: the start date cannot move past the first month that was posted
    if (input.startedOn) {
      const first = await tx.employeeLedgerEntry.findFirst({
        where: { companyId, employeeId: id, type: 'SALARY_EARNED', status: 'POSTED' },
        orderBy: { period: 'asc' },
        select: { period: true },
      });
      if (first?.period && toDateOnly(input.startedOn).getTime() > lastDayOf(first.period).getTime()) {
        throw conflict(`Salary for ${first.period} was already posted, so the start date canot be after that month. Cancel those salary entries first if the date is reallt later.`);
      }
    }
    const linkChange = input.userId !== undefined && input.userId !== e.userId;
    if (linkChange && input.userId) await checkLogin(tx, companyId, input.userId, id);
    if (input.status === 'INACTIVE' && e.status === 'ACTIVE') {
      const bal = (await balances(tx, companyId, id)).get(id) ?? ZERO;
      if (!bal.isZero()) {
        throw conflict(bal.gt(0) ? `The company still owes ${e.name} ${bal.toFixed(2)}. Pay it first.` : `${e.name} still owes the company ${bal.abs().toFixed(2)}. Settle it first (for example with an adjustment).`);
      }
    }
    await tx.employee.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
        ...(input.startedOn !== undefined ? { startedOn: input.startedOn ? toDateOnly(input.startedOn) : null } : {}),
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    }).catch(loginTaken);
    // The audit keeps what each changed field was before, so nothing is lost when details are edited.
    const was: Record<string, unknown> = {
      name: e.name,
      phone: e.phone,
      position: e.position,
      locationId: e.locationId,
      startedOn: e.startedOn ? fromDateOnly(e.startedOn) : null,
      userId: e.userId,
      status: e.status,
    }
    const before = Object.fromEntries(Object.keys(input).map((k) => [k, was[k]]));
    await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: 'employee.updated',
      entityType: 'employee',
      entityId: id,
      before: before as Prisma.InputJsonValue,
      after: input as Prisma.InputJsonValue,
      ip
    });
    if (linkChange) await writeAudit(tx, {
      companyId,
      userId: auth.userId,
      action: input.userId
        ? 'employee.login_linked'
        : 'employee.login_unlinked',
      entityType: 'employee',
      entityId: id,
      before: { userId: e.userId },
      after: { userId: input.userId ?? null },
      ip
    });
    return loadEmployee(tx, companyId, id);
  });
}

export async function setSalary(auth: AuthContext, id: string, input: SalaryInput, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${id}::uuid FOR UPDATE`;
    const e = await tx.employee.findFirst({ where: { id, companyId }, include: { salaryAgreements: { orderBy: { effectiveFrom: 'desc' } } } });
    if (!e) throw notFound('Employee not found');
    if (e.status !== 'ACTIVE') throw conflict(`${e.name} is switched off`);
    const from = toDateOnly(input.effectiveFrom);
    const latest = e.salaryAgreements[0];
    if (latest && from.getTime() <= latest.effectiveFrom.getTime()) {
      throw conflict(`The new pay must start after ${fromDateOnly(latest.effectiveFrom)}, when the current pay started`);
    }
    if (latest && (latest.endedOn === null || latest.endedOn >= from)) {
      await tx.salaryAgreement.update({ where: { id: latest.id }, data: { endedOn: addDays(from, -1) } });
    }
    await tx.salaryAgreement.create({ data: { companyId, employeeId: id, monthlyAmount: D(input.monthlyAmount).toString(), effectiveFrom: from } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'employee.salary_set', entityType: 'employee', entityId: id, ...(latest ? { before: { monthlyAmount: m(latest.monthlyAmount) } } : {}), after: { monthlyAmount: D(input.monthlyAmount).toFixed(2), effectiveFrom: input.effectiveFrom }, ip });
    return loadEmployee(tx, companyId, id);
  });
}

// ───────────────────────── The employee's ledger ─────────────────────────

const entryInclude = { financialAccount: { select: { id: true, name: true } } } satisfies Prisma.EmployeeLedgerEntryInclude;
type EntryRow = Prisma.EmployeeLedgerEntryGetPayload<{ include: typeof entryInclude }>;
const presentEntry = (x: EntryRow) => ({
  id: x.id,
  number: x.number,
  employeeId: x.employeeId,
  type: x.type,
  /** Always positive, except an adjustment: plus adds to what we owe, minus takes away. */
  amount: m(x.amount),
  period: x.period,
  account: x.financialAccount,
  occurredAt: fromDateOnly(x.occurredAt),
  status: x.status,
  note: x.note,
  voidReason: x.voidReason,
  createdById: x.createdById,
});

export async function employeeLedger(auth: AuthContext, id: string, f: { limit: number; cursor?: string | undefined }) {
  mustSee(auth);
  return withTenant(auth, async (tx) => {
    const e = await tx.employee.findFirst({ where: { id, companyId: auth.companyId }, select: { id: true } });
    if (!e) throw notFound('Employee not found');
    const rows = await tx.employeeLedgerEntry.findMany({ where: { companyId: auth.companyId, employeeId: id }, include: entryInclude, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(f) });
    const page = toPage(rows, f.limit);
    return { items: page.items.map(presentEntry), nextCursor: page.nextCursor };
  });
}

// ───────────────────────── Monthly salaries ─────────────────────────

type LineStatus = 'WILL_POST' | 'ALREADY_POSTED' | 'NO_SALARY' | 'NOT_STARTED';

async function previewIn(tx: Tx, companyId: string, period: string) {
  const last = lastDayOf(period);
  if (period > fromDateOnly(today()).slice(0, 7)) throw badRequest('You cannot post salaries for a month that has not started');
  const entryDate = last.getTime() > today().getTime() ? today() : last;
  const employees = await tx.employee.findMany({ where: { companyId, status: 'ACTIVE' }, include: empInclude, orderBy: [{ name: 'asc' }] });
  const done = await tx.employeeLedgerEntry.findMany({ where: { companyId, type: 'SALARY_EARNED', period, status: 'POSTED' }, select: { employeeId: true } });
  const doneSet = new Set(done.map((d) => d.employeeId));
  const lines = employees.map((e) => {
    const pay = inForce(e.salaryAgreements, last);
    let status: LineStatus = 'WILL_POST';
    if (doneSet.has(e.id)) status = 'ALREADY_POSTED';
    else if (e.startedOn && e.startedOn.getTime() > last.getTime()) status = 'NOT_STARTED';
    else if (!pay) status = 'NO_SALARY';
    return { employee: { id: e.id, name: e.name, location: e.location }, locationId: e.locationId, amount: pay ? m(pay.monthlyAmount) : null, status };
  });
  const toPost = lines.filter((l) => l.status === 'WILL_POST');
  const total = toPost.reduce((s, l) => s.plus(l.amount!), ZERO);
  return { period, entryDate, lines, toPost, total };
}

export async function preview(auth: AuthContext, period: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const p = await previewIn(tx, auth.companyId, period);
    return { period, entryDate: fromDateOnly(p.entryDate), total: p.total.toFixed(4), count: p.toPost.length, lines: p.lines.map(({ locationId: _l, ...l }) => l) };
  });
}

export async function accrue(auth: AuthContext, period: string, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    // Two people pressing the button at the same moment must not post the month twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${companyId}:${period}`}))`;
    const p = await previewIn(tx, companyId, period);
    if (p.toPost.length === 0) throw conflict('Nothing to post for this month: every employee is either already posted or has no pay set');
    const posted: ReturnType<typeof presentEntry>[] = [];
    for (const l of p.toPost) {
      const amount = D(l.amount!);
      const number = await nextDocumentNumber(tx, companyId, 'PRL', { prefix: 'PY' });
      const x = await tx.employeeLedgerEntry.create({
        data: { companyId, employeeId: l.employee.id, number, type: 'SALARY_EARNED', amount: amount.toString(), period, occurredAt: p.entryDate, createdById: auth.userId, note: null },
        include: entryInclude,
      });
      await postJournal(tx, { companyId, userId: auth.userId, draft: posting.salaryEarned({ employeeId: l.employee.id, amount, locationId: l.locationId }), entryDate: p.entryDate, sourceId: x.id, event: 'accrued' });
      posted.push(presentEntry(x));
    }
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payroll.accrued', entityType: 'payroll', entityId: companyId, after: { period, employees: posted.length, total: p.total.toFixed(2) }, ip });
    return { period, count: posted.length, total: p.total.toFixed(4), entries: posted };
  });
}

// ───────────────────────── Paying, advances, corrections, cancelling ─────────────────────────

export async function pay(auth: AuthContext, input: PayInput, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${input.employeeId}::uuid FOR UPDATE`;
    const e = await tx.employee.findFirst({ where: { id: input.employeeId, companyId } });
    if (!e) throw notFound('Employee not found');
    if (e.status !== 'ACTIVE') throw conflict(`${e.name} is switched off`);
    const account = await tx.financialAccount.findFirst({ where: { id: input.financialAccountId, companyId } });
    if (!account) throw notFound('Cash or bank account not found');
    if (account.status !== 'ACTIVE') throw badRequest(`"${account.name}" is switched off`);
    const day = input.paidOn ? toDateOnly(input.paidOn) : today();
    if (day.getTime() > today().getTime()) throw badRequest('The date cannot be in the future');

    const amount = D(input.amount);
    const owed = (await balances(tx, companyId, e.id)).get(e.id) ?? ZERO;
    if (input.kind === 'SALARY' && amount.gt(owed)) {
      throw conflict(`The company only owes ${e.name} ${nonNegative(owed).toFixed(2)}, so ${amount.toFixed(2)} cannot be paid as salary. Post the month's salaries first, or give it as an advance.`);
    }
    await lockMoneyAccount(tx, account.id);
    const bal = await moneyAccountBalance(tx, companyId, account.ledgerAccountId);
    if (amount.gt(bal)) throw conflict(`"${account.name}" only holds ${bal.toFixed(2)}, so ${amount.toFixed(2)} cannot be paid from it`);

    const number = await nextDocumentNumber(tx, companyId, 'PRL', { prefix: 'PY' });
    const x = await tx.employeeLedgerEntry.create({
      data: { companyId, employeeId: e.id, number, type: input.kind === 'SALARY' ? 'SALARY_PAID' : 'ADVANCE', amount: amount.toString(), financialAccountId: account.id, occurredAt: day, createdById: auth.userId, note: input.note ?? null },
      include: entryInclude,
    });
    await postJournal(tx, { companyId, userId: auth.userId, draft: posting.employeePayment({ employeeId: e.id, financialAccountId: account.ledgerAccountId, amount }), entryDate: day, sourceId: x.id, event: 'paid' });
    await writeAudit(tx, { companyId, userId: auth.userId, action: input.kind === 'SALARY' ? 'payroll.salary_paid' : 'payroll.advance_given', entityType: 'employee', entityId: e.id, after: { number, employee: e.name, amount: amount.toFixed(2), account: account.name }, ip });
    const after = (await balances(tx, companyId, e.id)).get(e.id) ?? ZERO;
    return { entry: presentEntry(x), balance: after.toFixed(4) };
  });
}

/** A negative "owed" never reads as a debt of the company in a message. */
const nonNegative = (v: Decimal): Decimal => (v.lt(0) ? ZERO : v);

export async function adjust(auth: AuthContext, input: AdjustInput, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${input.employeeId}::uuid FOR UPDATE`;
    const e = await tx.employee.findFirst({ where: { id: input.employeeId, companyId } });
    if (!e) throw notFound('Employee not found');
    if (e.status !== 'ACTIVE') throw conflict(`${e.name} is switched off`);
    const amount = D(input.amount.replace(/^\+/, ''));
    const number = await nextDocumentNumber(tx, companyId, 'PRL', { prefix: 'PY' });
    const day = today();
    const x = await tx.employeeLedgerEntry.create({
      data: { companyId, employeeId: e.id, number, type: 'ADJUSTMENT', amount: amount.toString(), occurredAt: day, createdById: auth.userId, note: input.note },
      include: entryInclude,
    });
    const up = posting.salaryEarned({ employeeId: e.id, amount: amount.abs(), locationId: e.locationId });
    await postJournal(tx, { companyId, userId: auth.userId, draft: amount.gt(0) ? up : posting.reverse(up), entryDate: day, sourceId: x.id, event: 'adjusted' });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payroll.adjusted', entityType: 'employee', entityId: e.id, after: { number, employee: e.name, amount: amount.toFixed(2), note: input.note }, ip });
    const after = (await balances(tx, companyId, e.id)).get(e.id) ?? ZERO;
    return { entry: presentEntry(x), balance: after.toFixed(4) };
  });
}

export async function voidEntry(auth: AuthContext, id: string, reason: string, ip?: string) {
  mustManage(auth);
  return withTenant(auth, async (tx) => {
    const companyId = auth.companyId;
    await tx.$queryRaw`SELECT id FROM employee_ledger_entries WHERE id = ${id}::uuid FOR UPDATE`;
    const x = await tx.employeeLedgerEntry.findFirst({ where: { id, companyId } });
    if (!x) throw notFound('Entry not found');
    if (x.status !== 'POSTED') throw conflict('This entry is already cancelled');
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${x.employeeId}::uuid FOR UPDATE`;
    const entries = await tx.journalEntry.findMany({ where: { companyId, sourceId: id, reversalOfId: null, reversedBy: { is: null } }, select: { id: true } });
    for (const j of entries) await reverseJournal(tx, { companyId, userId: auth.userId }, j.id, { date: today(), reason: `Cancelled ${x.number}: ${reason}` });
    await tx.employeeLedgerEntry.update({ where: { id }, data: { status: 'VOIDED', voidReason: reason } });
    await writeAudit(tx, { companyId, userId: auth.userId, action: 'payroll.voided', entityType: 'employee_ledger_entry', entityId: id, after: { number: x.number, type: x.type, reason }, ip });
    const full = await tx.employeeLedgerEntry.findFirstOrThrow({ where: { id, companyId }, include: entryInclude });
    const after = (await balances(tx, companyId, x.employeeId)).get(x.employeeId) ?? ZERO;
    return { entry: presentEntry(full), balance: after.toFixed(4) };
  });
}