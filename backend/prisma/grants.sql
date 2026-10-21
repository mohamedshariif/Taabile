-- Runtime permissions for the API's database user (taabile_app). Idempotent.
-- The app user can never update or delete ledgers, and cannot delete business documents.
GRANT USAGE ON SCHEMA public TO taabile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO taabile_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taabile_app;

REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_lines, stock_movements, audit_logs FROM taabile_app;

-- Records are deactivated or voided, never deleted.
REVOKE DELETE, TRUNCATE ON
  companies, users, platform_admins, memberships, locations, products, product_units, customers, suppliers,
  sales, sale_lines, sale_line_allocations, sale_releases, sale_release_lines, sale_returns, sale_return_lines,
  payments, payment_allocations, purchase_receipts, purchase_receipt_lines, purchase_costs,
  transfers, transfer_lines, stock_counts, stock_count_lines, stock_balances,
  funds_transfers, financial_accounts, expenses, expense_categories,
  employees, salary_agreements, employee_ledger_entries, accounts, accounting_periods
FROM taabile_app;
