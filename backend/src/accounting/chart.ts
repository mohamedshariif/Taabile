// Default chart of accounts for a trading company, created when a company is set up.
// Posting rules refer to accounts by systemKey, never by code, so owners can renumber freely.
// Each cash and bank FinancialAccount gets its own child account under CASH_ROOT or BANK_ROOT.

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export const SYSTEM_KEYS = [
  'CASH_ROOT',
  'CASH_IN_TRANSIT',
  'BANK_ROOT',
  'AR_CUSTOMERS',
  'INVENTORY',
  'GOODS_IN_TRANSIT',
  'AP_SUPPLIERS',
  'EMPLOYEE_PAYABLE',
  'TAX_PAYABLE',
  'OWNER_CAPITAL',
  'RETAINED_EARNINGS',
  'OPENING_EQUITY',
  'SALES_REVENUE',
  'SALES_RETURNS',
  'OTHER_INCOME',
  'COGS',
  'INVENTORY_ADJUSTMENTS',
  'INVENTORY_DAMAGE',
  'SALARY_EXPENSE',
  'RENT_EXPENSE',
  'UTILITIES_EXPENSE',
  'TRANSPORT_EXPENSE',
  'REPAIRS_EXPENSE',
  'OFFICE_EXPENSE',
  'CASH_DIFFERENCES',
  'BANK_FEES',
  'OTHER_EXPENSES',
] as const;

export type SystemKey = (typeof SYSTEM_KEYS)[number];

export interface ChartAccount {
  code: string;
  name: string;
  type: AccountType;
  systemKey: SystemKey;
  /** Parent accounts group children and cannot be posted to directly. */
  isPostable: boolean;
}

export const DEFAULT_CHART: ChartAccount[] = [
  { code: '1010', name: 'Cash on hand', type: 'ASSET', systemKey: 'CASH_ROOT', isPostable: false },
  { code: '1020', name: 'Cash in transit', type: 'ASSET', systemKey: 'CASH_IN_TRANSIT', isPostable: true },
  { code: '1100', name: 'Bank accounts', type: 'ASSET', systemKey: 'BANK_ROOT', isPostable: false },
  { code: '1200', name: 'Accounts receivable (customers)', type: 'ASSET', systemKey: 'AR_CUSTOMERS', isPostable: true },
  { code: '1300', name: 'Inventory', type: 'ASSET', systemKey: 'INVENTORY', isPostable: true },
  { code: '1310', name: 'Goods in transit', type: 'ASSET', systemKey: 'GOODS_IN_TRANSIT', isPostable: true },
  { code: '2100', name: 'Accounts payable (suppliers)', type: 'LIABILITY', systemKey: 'AP_SUPPLIERS', isPostable: true },
  { code: '2300', name: 'Amounts owed to employees', type: 'LIABILITY', systemKey: 'EMPLOYEE_PAYABLE', isPostable: true },
  { code: '2400', name: 'Tax payable', type: 'LIABILITY', systemKey: 'TAX_PAYABLE', isPostable: true },
  { code: '3100', name: "Owners' capital", type: 'EQUITY', systemKey: 'OWNER_CAPITAL', isPostable: true },
  { code: '3200', name: 'Retained earnings', type: 'EQUITY', systemKey: 'RETAINED_EARNINGS', isPostable: true },
  { code: '3900', name: 'Opening balance equity', type: 'EQUITY', systemKey: 'OPENING_EQUITY', isPostable: true },
  { code: '4100', name: 'Sales revenue', type: 'REVENUE', systemKey: 'SALES_REVENUE', isPostable: true },
  { code: '4150', name: 'Sales returns', type: 'REVENUE', systemKey: 'SALES_RETURNS', isPostable: true },
  { code: '4900', name: 'Other income', type: 'REVENUE', systemKey: 'OTHER_INCOME', isPostable: true },
  { code: '5100', name: 'Cost of goods sold', type: 'EXPENSE', systemKey: 'COGS', isPostable: true },
  { code: '5200', name: 'Inventory adjustments (count differences, losses)', type: 'EXPENSE', systemKey: 'INVENTORY_ADJUSTMENTS', isPostable: true },
  { code: '5210', name: 'Damaged and expired stock', type: 'EXPENSE', systemKey: 'INVENTORY_DAMAGE', isPostable: true },
  { code: '6100', name: 'Salaries and wages', type: 'EXPENSE', systemKey: 'SALARY_EXPENSE', isPostable: true },
  { code: '6200', name: 'Rent', type: 'EXPENSE', systemKey: 'RENT_EXPENSE', isPostable: true },
  { code: '6300', name: 'Utilities', type: 'EXPENSE', systemKey: 'UTILITIES_EXPENSE', isPostable: true },
  { code: '6400', name: 'Transport and fuel', type: 'EXPENSE', systemKey: 'TRANSPORT_EXPENSE', isPostable: true },
  { code: '6500', name: 'Repairs and maintenance', type: 'EXPENSE', systemKey: 'REPAIRS_EXPENSE', isPostable: true },
  { code: '6600', name: 'Office and supplies', type: 'EXPENSE', systemKey: 'OFFICE_EXPENSE', isPostable: true },
  { code: '6700', name: 'Cash shortages and overages', type: 'EXPENSE', systemKey: 'CASH_DIFFERENCES', isPostable: true },
  { code: '6710', name: 'Bank fees', type: 'EXPENSE', systemKey: 'BANK_FEES', isPostable: true },
  { code: '6900', name: 'Other expenses', type: 'EXPENSE', systemKey: 'OTHER_EXPENSES', isPostable: true },
];

/** Default expense categories and the account each one posts to. */
export const DEFAULT_EXPENSE_CATEGORIES: { name: string; systemKey: SystemKey }[] = [
  { name: 'Rent', systemKey: 'RENT_EXPENSE' },
  { name: 'Utilities', systemKey: 'UTILITIES_EXPENSE' },
  { name: 'Transport and fuel', systemKey: 'TRANSPORT_EXPENSE' },
  { name: 'Repairs and maintenance', systemKey: 'REPAIRS_EXPENSE' },
  { name: 'Office and supplies', systemKey: 'OFFICE_EXPENSE' },
  { name: 'Other', systemKey: 'OTHER_EXPENSES' },
];
