-- Taabile database rules. Idempotent: safe to run after every `prisma migrate deploy`.
-- Table names are snake_case (@@map); column names keep Prisma's camelCase and must be quoted.

-- ───────── 1. Case-insensitive unique email ─────────
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- ───────── 2. Value checks ─────────
-- Stock: never negative, and available (on hand - committed) never negative.
ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_valid;
ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_valid
  CHECK ("onHand" >= 0 AND committed >= 0 AND "onHand" >= committed);

ALTER TABLE sale_line_allocations DROP CONSTRAINT IF EXISTS sale_line_allocations_valid;
ALTER TABLE sale_line_allocations ADD CONSTRAINT sale_line_allocations_valid
  CHECK ("qtyBase" > 0 AND "qtyReleased" >= 0 AND "qtyReleased" <= "qtyBase");

ALTER TABLE product_units DROP CONSTRAINT IF EXISTS product_units_factor_positive;
ALTER TABLE product_units ADD CONSTRAINT product_units_factor_positive CHECK ("factorToBase" > 0);

ALTER TABLE transfers DROP CONSTRAINT IF EXISTS transfers_distinct_locations;
ALTER TABLE transfers ADD CONSTRAINT transfers_distinct_locations CHECK ("fromLocationId" <> "toLocationId");

ALTER TABLE transfer_lines DROP CONSTRAINT IF EXISTS transfer_lines_valid;
ALTER TABLE transfer_lines ADD CONSTRAINT transfer_lines_valid
  CHECK ("qtyRequested" > 0 AND "qtyDispatched" >= 0 AND "qtyDispatched" <= "qtyRequested"
         AND "qtyReceived" >= 0 AND "qtyReceived" <= "qtyDispatched");

ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_amounts_valid;
ALTER TABLE sales ADD CONSTRAINT sales_amounts_valid
  CHECK (total >= 0 AND "paidTotal" >= 0 AND "paidTotal" <= total);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_valid;
ALTER TABLE payments ADD CONSTRAINT payments_valid CHECK (
  amount > 0 AND (
    ("partyType" = 'CUSTOMER' AND "supplierId" IS NULL) OR
    ("partyType" = 'SUPPLIER' AND "supplierId" IS NOT NULL AND "customerId" IS NULL)));

ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_valid;
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_valid CHECK (
  amount > 0 AND (("saleId" IS NOT NULL)::int + ("purchaseReceiptId" IS NOT NULL)::int) = 1);

ALTER TABLE funds_transfers DROP CONSTRAINT IF EXISTS funds_transfers_valid;
ALTER TABLE funds_transfers ADD CONSTRAINT funds_transfers_valid
  CHECK (amount > 0 AND "fromAccountId" <> "toAccountId");

ALTER TABLE accounting_periods DROP CONSTRAINT IF EXISTS accounting_periods_month;
ALTER TABLE accounting_periods ADD CONSTRAINT accounting_periods_month CHECK (month BETWEEN 1 AND 12);

-- Journal line: exactly one side, positive.
ALTER TABLE journal_lines DROP CONSTRAINT IF EXISTS journal_lines_one_side;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_one_side
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit > 0 OR credit > 0));

-- ───────── 3. Balanced journals (checked at commit) ─────────
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n int; eid uuid;
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN eid := NEW."entryId"; ELSE eid := NEW.id; END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*) INTO d, c, n
    FROM journal_lines WHERE "entryId" = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'Journal entry % needs at least two lines', eid USING ERRCODE = '23514';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debit %, credit %)', eid, d, c USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_lines_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

DROP TRIGGER IF EXISTS journal_entries_has_lines ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_has_lines AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- ───────── 4. Closed periods reject new entries; entry date must match its period ─────────
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS trigger AS $$
DECLARE p_year int; p_month int; p_status text;
BEGIN
  SELECT year, month, status::text INTO p_year, p_month, p_status
    FROM accounting_periods WHERE id = NEW."periodId";
  IF p_status IS NULL THEN
    RAISE EXCEPTION 'Accounting period not found' USING ERRCODE = '23503';
  END IF;
  IF p_status <> 'OPEN' THEN
    RAISE EXCEPTION 'Accounting period %-% is locked', p_year, p_month USING ERRCODE = '23514';
  END IF;
  IF EXTRACT(YEAR FROM NEW."entryDate") <> p_year OR EXTRACT(MONTH FROM NEW."entryDate") <> p_month THEN
    RAISE EXCEPTION 'Entry date % is outside period %-%', NEW."entryDate", p_year, p_month USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_period_open ON journal_entries;
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- ───────── 5. Append-only tables ─────────
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only, use a reversal', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries', 'journal_lines', 'stock_movements', 'audit_logs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()',
                   t || '_append_only', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ───────── 6. Tenant isolation (row-level security) ─────────
-- The API sets app.company_id (and app.user_id) at the start of every transaction.
-- FORCE makes the policy apply to the table owner too. Only superusers bypass it.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'companyId' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("companyId" = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK ("companyId" = nullif(current_setting('app.company_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  USING (id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.company_id', true), '')::uuid);

-- Login: a user may list their own memberships before a company is chosen.
DROP POLICY IF EXISTS own_memberships ON memberships;
CREATE POLICY own_memberships ON memberships FOR SELECT
  USING ("userId" = nullif(current_setting('app.user_id', true), '')::uuid);

-- Accepting an invitation: look it up by token hash before any company is known.
DROP POLICY IF EXISTS invitation_by_token ON invitations;
CREATE POLICY invitation_by_token ON invitations
  USING ("tokenHash" = nullif(current_setting('app.invite_token_hash', true), ''));

-- ───────── 7. Products and units ─────────
-- The base unit always converts at exactly 1, and no conversion is absurdly large.
ALTER TABLE product_units DROP CONSTRAINT IF EXISTS product_units_base_factor;
ALTER TABLE product_units ADD CONSTRAINT product_units_base_factor CHECK (NOT "isBase" OR "factorToBase" = 1);
ALTER TABLE product_units DROP CONSTRAINT IF EXISTS product_units_factor_max;
ALTER TABLE product_units ADD CONSTRAINT product_units_factor_max CHECK ("factorToBase" <= 1000000);

-- Unit rules the database enforces even if application code has a bug:
--   * unit names are unique per product ignoring upper/lower case ("Sack" and "sack" clash)
--   * a product has at most one base unit, and a unit can never become (or stop being) the base unit
--   * once a purchase or sale line uses a unit, its conversion can never change: history keeps its meaning
-- (These are triggers rather than partial indexes because Prisma would drop partial indexes on the next migration.
--  The API takes a row lock on the product before changing units, so two requests cannot slip past these checks together.)
CREATE OR REPLACE FUNCTION guard_product_unit() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_units u
             WHERE u."productId" = NEW."productId" AND u.id <> NEW.id AND lower(u.name) = lower(NEW.name)) THEN
    RAISE EXCEPTION 'This product already has a unit called %', NEW.name USING ERRCODE = '23505';
  END IF;
  IF NEW."isBase" AND EXISTS (SELECT 1 FROM product_units u
                              WHERE u."productId" = NEW."productId" AND u.id <> NEW.id AND u."isBase") THEN
    RAISE EXCEPTION 'A product can have only one base unit' USING ERRCODE = '23505';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."isBase" <> OLD."isBase" OR NEW."productId" <> OLD."productId" THEN
      RAISE EXCEPTION 'A unit cannot move to another product or become the base unit' USING ERRCODE = '23514';
    END IF;
    IF NEW."factorToBase" <> OLD."factorToBase" AND (
         EXISTS (SELECT 1 FROM purchase_receipt_lines l WHERE l."productUnitId" = OLD.id)
      OR EXISTS (SELECT 1 FROM sale_lines l WHERE l."productUnitId" = OLD.id)) THEN
      RAISE EXCEPTION 'Unit % is already used on documents, so its conversion cannot change', OLD.name USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_units_guard ON product_units;
CREATE TRIGGER product_units_guard BEFORE INSERT OR UPDATE ON product_units
  FOR EACH ROW EXECUTE FUNCTION guard_product_unit();

-- Once a product has stock history, its base unit and its "whole numbers only" rule are frozen.
-- (Allowing fractions later is harmless and stays possible.)
CREATE OR REPLACE FUNCTION guard_product() RETURNS trigger AS $$
BEGIN
  IF NEW."baseUnit" <> OLD."baseUnit" OR (OLD."allowFractions" AND NOT NEW."allowFractions") THEN
    IF EXISTS (SELECT 1 FROM stock_movements m WHERE m."productId" = OLD.id)
       OR EXISTS (SELECT 1 FROM purchase_receipt_lines l WHERE l."productId" = OLD.id)
       OR EXISTS (SELECT 1 FROM sale_lines l WHERE l."productId" = OLD.id) THEN
      RAISE EXCEPTION 'This product already has stock history, so its base unit and whole-number rule cannot change'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_guard ON products;
CREATE TRIGGER products_guard BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION guard_product();

-- ───────── 7. Stock rules (Step G) ─────────
-- A cost is never negative.
ALTER TABLE stock_balances DROP CONSTRAINT IF EXISTS stock_balances_cost_valid;
ALTER TABLE stock_balances ADD CONSTRAINT stock_balances_cost_valid CHECK ("avgCost" >= 0);

-- A movement's direction must match its type: arrivals add stock, issues remove it, and its value has the same sign.
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS stock_movements_direction;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_direction CHECK (
  quantity <> 0 AND "unitCost" >= 0 AND (
    (type IN ('OPENING', 'RECEIPT', 'TRANSFER_IN', 'RETURN_IN') AND quantity > 0 AND "totalCost" >= 0) OR
    (type IN ('TRANSFER_OUT', 'SALE_RELEASE', 'RETURN_OUT', 'DAMAGE') AND quantity < 0 AND "totalCost" <= 0) OR
    (type IN ('ADJUSTMENT', 'REVERSAL') AND ((quantity > 0 AND "totalCost" >= 0) OR (quantity < 0 AND "totalCost" <= 0)))
  ));

-- A movement must use a location and product of its own company, and a reversal must be the exact mirror of the movement it reverses.
CREATE OR REPLACE FUNCTION stock_movement_guard() RETURNS trigger AS $$
DECLARE orig stock_movements%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."locationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A stock movement must use a location of its own company' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = NEW."productId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A stock movement must use a product of its own company' USING ERRCODE = '23514';
  END IF;
  IF NEW."reversalOfId" IS NOT NULL THEN
    SELECT * INTO orig FROM stock_movements WHERE id = NEW."reversalOfId";
    IF NEW.type <> 'REVERSAL' OR orig.id IS NULL OR orig.type = 'REVERSAL'
       OR orig."companyId" <> NEW."companyId" OR orig."locationId" <> NEW."locationId" OR orig."productId" <> NEW."productId"
       OR orig.quantity <> -NEW.quantity THEN
      RAISE EXCEPTION 'A reversal must be the exact opposite of the movement it reverses' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.type = 'REVERSAL' THEN
    RAISE EXCEPTION 'A reversal must say which movement it reverses' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stock_movements_guard ON stock_movements;
CREATE TRIGGER stock_movements_guard BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movement_guard();

-- Stock on hand must always equal the sum of its movements (checked at commit), whoever changed which table.
CREATE OR REPLACE FUNCTION assert_stock_matches_movements() RETURNS trigger AS $$
DECLARE moved numeric; held numeric;
BEGIN
  SELECT COALESCE(sum(quantity), 0) INTO moved FROM stock_movements
    WHERE "companyId" = NEW."companyId" AND "locationId" = NEW."locationId" AND "productId" = NEW."productId";
  SELECT COALESCE(sum("onHand"), 0) INTO held FROM stock_balances
    WHERE "locationId" = NEW."locationId" AND "productId" = NEW."productId";
  IF moved <> held THEN
    RAISE EXCEPTION 'Stock on hand (%) does not match its movement history (%)', held, moved USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stock_movements_match ON stock_movements;
CREATE CONSTRAINT TRIGGER stock_movements_match AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_stock_matches_movements();
DROP TRIGGER IF EXISTS stock_balances_match ON stock_balances;
CREATE CONSTRAINT TRIGGER stock_balances_match AFTER INSERT OR UPDATE OF "onHand" ON stock_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_stock_matches_movements();


-- ───────── 8. Purchase receipt rules (Step H) ─────────
ALTER TABLE purchase_receipt_lines DROP CONSTRAINT IF EXISTS purchase_receipt_lines_valid;
ALTER TABLE purchase_receipt_lines ADD CONSTRAINT purchase_receipt_lines_valid CHECK (
  "qtyReceived" > 0 AND "qtyReceivedBase" > 0 AND "qtyDamaged" >= 0 AND "qtyExpected" >= 0
  AND "unitCost" >= 0 AND "landedUnitCostBase" >= 0 AND "lineTotal" >= 0);
ALTER TABLE purchase_costs DROP CONSTRAINT IF EXISTS purchase_costs_valid;
ALTER TABLE purchase_costs ADD CONSTRAINT purchase_costs_valid CHECK (amount > 0);
ALTER TABLE purchase_receipts DROP CONSTRAINT IF EXISTS purchase_receipts_valid;
ALTER TABLE purchase_receipts ADD CONSTRAINT purchase_receipts_valid CHECK (
  "goodsTotal" >= 0 AND "costTotal" >= 0 AND total >= 0 AND "paidTotal" >= 0 AND "paidTotal" <= total);

-- A receipt must use a supplier and a location of its own company.
CREATE OR REPLACE FUNCTION purchase_receipt_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = NEW."supplierId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A purchase receipt must use a supplier of its own company' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."locationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A purchase receipt must use a location of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS purchase_receipts_guard ON purchase_receipts;
CREATE TRIGGER purchase_receipts_guard BEFORE INSERT OR UPDATE OF "supplierId", "locationId" ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION purchase_receipt_guard();


-- ───────── 9. Transfer and stock count rules (Step I) ─────────
-- A count line is internally consistent: nothing negative, and the difference is exactly counted minus expected.
ALTER TABLE stock_count_lines DROP CONSTRAINT IF EXISTS stock_count_lines_valid;
ALTER TABLE stock_count_lines ADD CONSTRAINT stock_count_lines_valid CHECK (
  "expectedQty" >= 0 AND "countedQty" >= 0 AND difference = "countedQty" - "expectedQty");

-- Transfers and counts only ever use places and products of their own company.
CREATE OR REPLACE FUNCTION transfer_guard() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM locations WHERE "companyId" = NEW."companyId" AND id IN (NEW."fromLocationId", NEW."toLocationId")) <> 2 THEN
    RAISE EXCEPTION 'A transfer must use two places of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transfers_guard ON transfers;
CREATE TRIGGER transfers_guard BEFORE INSERT OR UPDATE OF "fromLocationId", "toLocationId" ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfer_guard();

CREATE OR REPLACE FUNCTION stock_count_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."locationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A stock count must use a place of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS stock_counts_guard ON stock_counts;
CREATE TRIGGER stock_counts_guard BEFORE INSERT OR UPDATE OF "locationId" ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION stock_count_guard();

-- Lines must use a product of their own company.
CREATE OR REPLACE FUNCTION document_line_product_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM products WHERE id = NEW."productId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A document line must use a product of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS transfer_lines_product_guard ON transfer_lines;
CREATE TRIGGER transfer_lines_product_guard BEFORE INSERT ON transfer_lines
  FOR EACH ROW EXECUTE FUNCTION document_line_product_guard();
DROP TRIGGER IF EXISTS stock_count_lines_product_guard ON stock_count_lines;
CREATE TRIGGER stock_count_lines_product_guard BEFORE INSERT ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION document_line_product_guard();

-- ───────── 10. Money account rules (Step K1) ─────────
-- A cash drawer belongs to a place; a bank account belongs to the company (no place).
ALTER TABLE financial_accounts DROP CONSTRAINT IF EXISTS financial_accounts_place_rule;
ALTER TABLE financial_accounts ADD CONSTRAINT financial_accounts_place_rule CHECK (
  (type = 'CASH' AND "locationId" IS NOT NULL) OR (type = 'BANK' AND "locationId" IS NULL));

-- Every money account has its own accounting account, and it must be an asset account of the same company.
CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_ledger_unique ON financial_accounts ("ledgerAccountId");
CREATE OR REPLACE FUNCTION financial_account_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW."ledgerAccountId" AND "companyId" = NEW."companyId" AND type = 'ASSET') THEN
    RAISE EXCEPTION 'A money account must use an asset account of its own company' USING ERRCODE = '23514';
  END IF;
  IF NEW."locationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."locationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A money account must use a place of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS financial_accounts_guard ON financial_accounts;
CREATE TRIGGER financial_accounts_guard BEFORE INSERT OR UPDATE OF "ledgerAccountId", "locationId" ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION financial_account_guard();

-- ───────── 11. Sales rules (Step K2) ─────────
ALTER TABLE sale_lines DROP CONSTRAINT IF EXISTS sale_lines_valid;
ALTER TABLE sale_lines ADD CONSTRAINT sale_lines_valid CHECK (
  quantity > 0 AND "quantityBase" > 0 AND "unitPrice" >= 0 AND discount >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0);

ALTER TABLE sale_release_lines DROP CONSTRAINT IF EXISTS sale_release_lines_valid;
ALTER TABLE sale_release_lines ADD CONSTRAINT sale_release_lines_valid CHECK ("qtyBase" > 0);

-- A sale uses a place and a customer of its own company.
CREATE OR REPLACE FUNCTION sale_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."locationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A sale must use a place of its own company' USING ERRCODE = '23514';
  END IF;
  IF NEW."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW."customerId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'A sale must use a customer of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sales_guard ON sales;
CREATE TRIGGER sales_guard BEFORE INSERT ON sales FOR EACH ROW EXECUTE FUNCTION sale_guard();

-- A sale line uses a product of its own company, and a unit that belongs to that product.
DROP TRIGGER IF EXISTS sale_lines_product_guard ON sale_lines;
CREATE TRIGGER sale_lines_product_guard BEFORE INSERT ON sale_lines
  FOR EACH ROW EXECUTE FUNCTION document_line_product_guard();
CREATE OR REPLACE FUNCTION sale_line_unit_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product_units WHERE id = NEW."productUnitId" AND "productId" = NEW."productId") THEN
    RAISE EXCEPTION 'A sale line must use a unit of its own product' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_lines_unit_guard ON sale_lines;
CREATE TRIGGER sale_lines_unit_guard BEFORE INSERT ON sale_lines FOR EACH ROW EXECUTE FUNCTION sale_line_unit_guard();

-- Goods are supplied from a place of the sale's own company.
CREATE OR REPLACE FUNCTION sale_allocation_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = NEW."supplyLocationId" AND "companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'Goods must be supplied from a place of its own company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS sale_allocations_guard ON sale_line_allocations;
CREATE TRIGGER sale_allocations_guard BEFORE INSERT ON sale_line_allocations FOR EACH ROW EXECUTE FUNCTION sale_allocation_guard();


-- ───────── 12. Payment rules (Step L) ─────────
-- A bill can never be paid more than it is worth.
ALTER TABLE purchase_receipts DROP CONSTRAINT IF EXISTS purchase_receipts_paid_valid;
ALTER TABLE purchase_receipts ADD CONSTRAINT purchase_receipts_paid_valid CHECK ("paidTotal" >= 0 AND "paidTotal" <= total);

-- A payment is matched only to documents of the same company and the same customer or supplier,
-- and what it is matched to never adds up to more than the payment.
CREATE OR REPLACE FUNCTION payment_allocation_guard() RETURNS trigger AS $$
DECLARE pay payments%ROWTYPE; matched numeric;
BEGIN
  SELECT * INTO pay FROM payments WHERE id = NEW."paymentId";
  IF NEW."saleId" IS NOT NULL THEN
    IF pay."partyType" <> 'CUSTOMER' OR NOT EXISTS (
      SELECT 1 FROM sales WHERE id = NEW."saleId" AND "companyId" = NEW."companyId" AND "customerId" IS NOT DISTINCT FROM pay."customerId") THEN
      RAISE EXCEPTION 'A payment can only settle invoices of its own customer' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF pay."partyType" <> 'SUPPLIER' OR NOT EXISTS (
      SELECT 1 FROM purchase_receipts WHERE id = NEW."purchaseReceiptId" AND "companyId" = NEW."companyId" AND "supplierId" = pay."supplierId") THEN
      RAISE EXCEPTION 'A payment can only settle bills of its own supplier' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO matched FROM payment_allocations WHERE "paymentId" = NEW."paymentId" AND id <> NEW.id;
  IF matched + NEW.amount > pay.amount THEN
    RAISE EXCEPTION 'A payment cannot be matched to more than its amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_allocations_guard ON payment_allocations;
CREATE TRIGGER payment_allocations_guard BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION payment_allocation_guard();