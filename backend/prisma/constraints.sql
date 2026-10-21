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
    ("partyType" = 'CUSTOMER' AND "customerId" IS NOT NULL AND "supplierId" IS NULL) OR
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
