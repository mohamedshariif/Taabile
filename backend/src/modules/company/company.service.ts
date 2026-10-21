import type { Prisma } from '@prisma/client';
import { withTenant, type Tx } from '../../db/client.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { writeAudit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { seedCompanyDefaults } from './company.default.js';
import type { UpdateCompanyInput } from './company.schemas.js';

type CompanyRow = Awaited<ReturnType<Tx['company']['findUniqueOrThrow']>>;

const present = (c: CompanyRow) => ({
  id: c.id,
  name: c.name,
  legalName: c.legalName,
  country: c.country,
  currency: c.currency,
  timezone: c.timezone,
  fiscalYearStartMonth: c.fiscalYearStartMonth,
  taxRate: c.taxRate.toFixed(4), // money-like numbers travel as strings
  status: c.status,
});

async function setupStatus(tx: Tx, companyId: string) {
  const [accounts, priceLists, periods] = await Promise.all([
    tx.account.count({ where: { companyId } }),
    tx.priceList.count({ where: { companyId } }),
    tx.accountingPeriod.count({ where: { companyId } }),
  ]);
  return { accounts, priceLists, periods, defaultsReady: accounts >= 27 && priceLists >= 1 && periods >= 1 };
}

export async function getCompany(auth: AuthContext) {
  return withTenant(auth, async (tx) => {
    const c = await tx.company.findUnique({ where: { id: auth.companyId } });
    if (!c) throw notFound('Company not found');
    return { company: present(c), setup: await setupStatus(tx, auth.companyId) };
  });
}

export async function updateCompany(auth: AuthContext, input: UpdateCompanyInput, ip?: string) {
  return withTenant(auth, async (tx) => {
    const before = await tx.company.findUniqueOrThrow({ where: { id: auth.companyId } });
    const data: Prisma.CompanyUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.legalName !== undefined) data.legalName = input.legalName;
    if (input.taxRate !== undefined) data.taxRate = input.taxRate;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    const after = await tx.company.update({ where: { id: auth.companyId }, data });
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'company.updated',
      entityType: 'company',
      entityId: auth.companyId,
      before: present(before),
      after: present(after),
      ip,
    });
    return { company: present(after) };
  });
}

/** Adds whatever default accounts, categories, price lists and periods are missing. Safe to run any number of times. */
export async function ensureDefaults(auth: AuthContext, ip?: string) {
  return withTenant(auth, async (tx) => {
    await seedCompanyDefaults(tx, auth.companyId);
    await writeAudit(tx, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: 'company.defaults_ensured',
      entityType: 'company',
      entityId: auth.companyId,
      ip,
    });
    return { setup: await setupStatus(tx, auth.companyId) };
  });
}