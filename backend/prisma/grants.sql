-- Runtime permissions for the API's database user (taabile_app). Idempotent.
-- The app user can never update or delete ledgers, and cannot delete business documents.
GRANT USAGE ON SCHEMA public TO taabile_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO taabile_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taabile_app;

REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, journal_lines, stock_movements, audit_logs FROM taabile_app;

-- Records are deactivated or voided, never deleted. Document numbering counters are never deleted either
-- (deleting one would restart the numbers and create duplicates).
REVOKE DELETE, TRUNCATE ON
  document_sequences,
  companies, users, platform_admins, memberships, locations,
  sales, sale_lines, sale_line_allocations, sale_releases, sale_release_lines, sale_returns, sale_return_lines,
  payments, payment_allocations, purchase_receipts, purchase_receipt_lines, purchase_costs,
  transfers, transfer_lines, stock_counts, stock_count_lines, stock_balances,
  funds_transfers, financial_accounts, expenses,
  employees, salary_agreements, employee_ledger_entries, accounts, accounting_periods
FROM taabile_app;

-- The ONLY business records that may be deleted: master data created by mistake and never used
-- (products with their units and prices, categories, price lists, customers, suppliers, expense categories).
-- The database refuses it when anything still refers to the record (every link is ON DELETE RESTRICT),
-- and the API allows it to the Admin only. TRUNCATE stays forbidden.
REVOKE TRUNCATE ON categories, price_lists, product_prices, product_units, products, customers, suppliers, expense_categories FROM taabile_app;