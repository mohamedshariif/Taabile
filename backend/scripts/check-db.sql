-- Taabile database check.
-- Run it as your normal PostgreSQL user (the one that can create databases):
--     psql -d taabile -f scripts/check-db.sql
-- It prints PASS or FAIL for each rule. Everything runs inside one transaction that is
-- rolled back at the end, so nothing is saved and your data is untouched.

\set VERBOSITY terse
\set ON_ERROR_STOP off
\o /dev/null
SET client_min_messages = notice;

BEGIN;

-- Helper (disappears with the rollback): runs some SQL and checks it fails with the expected error code.
CREATE FUNCTION check_expect_error(label text, wanted text, stmts text) RETURNS void AS $$
BEGIN
  EXECUTE stmts;
  RAISE NOTICE 'FAIL: % (it was accepted but should be rejected)', label;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = wanted THEN
    RAISE NOTICE 'PASS: %', label;
  ELSE
    RAISE NOTICE 'FAIL: % (wrong error %: %)', label, SQLSTATE, SQLERRM;
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_expect_ok(label text, stmts text) RETURNS void AS $$
BEGIN
  EXECUTE stmts;
  RAISE NOTICE 'PASS: %', label;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL: % (error %: %)', label, SQLSTATE, SQLERRM;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION check_expect_count(label text, query text, wanted bigint) RETURNS void AS $$
DECLARE n bigint;
BEGIN
  EXECUTE query INTO n;
  IF n = wanted THEN RAISE NOTICE 'PASS: % (%)', label, n;
  ELSE RAISE NOTICE 'FAIL: % (got %, expected %)', label, n, wanted; END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'FAIL: % (error %: %)', label, SQLSTATE, SQLERRM;
END $$ LANGUAGE plpgsql;

-- ───────── 1. Structure ─────────
SELECT check_expect_count('47 tables exist',
  $q$SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'$q$, 47);
SELECT check_expect_count('11 rule triggers installed',
  $q$SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal$q$, 11);
SELECT check_expect_count('46 tenant isolation policies installed',
  $q$SELECT count(*) FROM pg_policies$q$, 46);

-- ───────── 2. Test data (rolled back at the end) ─────────
INSERT INTO companies (id, name, country, "updatedAt") VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Check Co A', 'SS', now()),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Check Co B', 'SS', now());
INSERT INTO accounting_periods (id, "companyId", year, month, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 2026, 10, 'OPEN'),
  ('bbbbbbbb-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 2026, 9, 'LOCKED');
INSERT INTO accounts (id, "companyId", code, name, type) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '1010', 'Cash', 'ASSET'),
  ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '4100', 'Sales', 'REVENUE');
INSERT INTO locations (id, "companyId", name, code, type) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Store A', 'A', 'STORE');
INSERT INTO products (id, "companyId", sku, name, "baseUnit", "updatedAt") VALUES
  ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'RICE', 'Rice', 'kg', now());

-- ───────── 3. Journals ─────────
SELECT check_expect_ok('a balanced journal entry is accepted', $q$
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'J1', '2026-10-14', 'bbbbbbbb-0000-0000-0000-000000000010', 'ok', 'CHECK', 'check-1', 'a0a0a0a0-0000-0000-0000-000000000001');
  INSERT INTO journal_lines (id, "companyId", "entryId", "accountId", debit, credit) VALUES
    (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 100, 0),
    (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000002', 0, 100);
  SET CONSTRAINTS ALL IMMEDIATE$q$);

SELECT check_expect_error('an unbalanced journal entry (100 vs 90) is rejected', '23514', $q$
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'J2', '2026-10-14', 'bbbbbbbb-0000-0000-0000-000000000010', 'bad', 'CHECK', 'check-2', 'a0a0a0a0-0000-0000-0000-000000000001');
  INSERT INTO journal_lines (id, "companyId", "entryId", "accountId", debit, credit) VALUES
    (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001', 100, 0),
    (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000002', 0, 90);
  SET CONSTRAINTS ALL IMMEDIATE$q$);

SELECT check_expect_error('a journal entry with only one line is rejected', '23514', $q$
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'J3', '2026-10-14', 'bbbbbbbb-0000-0000-0000-000000000010', 'one line', 'CHECK', 'check-3', 'a0a0a0a0-0000-0000-0000-000000000001');
  INSERT INTO journal_lines (id, "companyId", "entryId", "accountId", debit, credit) VALUES
    (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001', 100, 0);
  SET CONSTRAINTS ALL IMMEDIATE$q$);

SELECT check_expect_error('a line with both debit and credit is rejected', '23514', $q$
  INSERT INTO journal_lines (id, "companyId", "entryId", "accountId", debit, credit)
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 5, 5)$q$);

SELECT check_expect_error('the same posting key cannot be used twice (no double posting)', '23505', $q$
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'J4', '2026-10-14', 'bbbbbbbb-0000-0000-0000-000000000010', 'dup', 'CHECK', 'check-1', 'a0a0a0a0-0000-0000-0000-000000000001')$q$);

SELECT check_expect_error('an entry into a locked period is rejected', '23514', $q$
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'J5', '2026-09-15', 'bbbbbbbb-0000-0000-0000-000000000009', 'locked', 'CHECK', 'check-5', 'a0a0a0a0-0000-0000-0000-000000000001')$q$);

SELECT check_expect_error('an entry dated outside its period is rejected', '23514', $q$
  INSERT INTO journal_entries (id, "companyId", number, "entryDate", "periodId", description, "sourceType", "postingKey", "createdById")
    VALUES ('ffffffff-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'J6', '2026-11-01', 'bbbbbbbb-0000-0000-0000-000000000010', 'wrong month', 'CHECK', 'check-6', 'a0a0a0a0-0000-0000-0000-000000000001')$q$);

SELECT check_expect_error('a posted journal line cannot be edited', '42501',
  $q$UPDATE journal_lines SET debit = 1$q$);
SELECT check_expect_error('a posted journal entry cannot be deleted', '42501',
  $q$DELETE FROM journal_entries$q$);

-- ───────── 4. Stock ─────────
SELECT check_expect_error('negative stock is rejected', '23514', $q$
  INSERT INTO stock_balances (id, "companyId", "locationId", "productId", "onHand", "updatedAt")
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', -1, now())$q$);

SELECT check_expect_error('committing more than is on hand is rejected', '23514', $q$
  INSERT INTO stock_balances (id, "companyId", "locationId", "productId", "onHand", committed, "updatedAt")
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 5, 6, now())$q$);

SELECT check_expect_ok('10 on hand with 4 committed is accepted', $q$
  INSERT INTO stock_balances (id, "companyId", "locationId", "productId", "onHand", committed, "updatedAt")
    VALUES ('99999999-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 10, 4, now())$q$);

SELECT check_expect_error('selling the last units twice (committing 7 more) is rejected', '23514',
  $q$UPDATE stock_balances SET committed = committed + 7 WHERE id = '99999999-0000-0000-0000-000000000001'$q$);

SELECT check_expect_ok('a stock movement can be recorded', $q$
  INSERT INTO stock_movements (id, "companyId", "locationId", "productId", type, quantity, "refType", "createdById")
    VALUES ('88888888-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'RECEIPT', 10, 'CHECK', 'a0a0a0a0-0000-0000-0000-000000000001')$q$);

SELECT check_expect_error('a stock movement cannot be edited', '42501',
  $q$UPDATE stock_movements SET quantity = 99$q$);

-- ───────── 5. The API user (taabile_app): permissions and company isolation ─────────
SET LOCAL ROLE taabile_app;
SELECT set_config('app.company_id', 'aaaaaaaa-0000-0000-0000-000000000001', true);

SELECT check_expect_count('company A sees only itself (1 company, not 2)', $q$SELECT count(*) FROM companies$q$, 1);
SELECT check_expect_count('company A sees its own journal entries', $q$SELECT count(*) FROM journal_entries$q$, 1);
SELECT check_expect_error('company A cannot write into company B', '42501', $q$
  INSERT INTO locations (id, "companyId", name, code, type)
    VALUES (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000002', 'Sneaky', 'S', 'STORE')$q$);
SELECT check_expect_error('the API user cannot edit journal lines', '42501',
  $q$UPDATE journal_lines SET debit = 1$q$);
SELECT check_expect_error('the API user cannot delete stock movements', '42501',
  $q$DELETE FROM stock_movements$q$);
SELECT check_expect_error('the API user cannot delete products', '42501',
  $q$DELETE FROM products$q$);

SELECT set_config('app.company_id', '', true);
SELECT check_expect_count('with no company selected, nothing is visible', $q$SELECT count(*) FROM journal_entries$q$, 0);

-- ───────── Finish: undo everything ─────────
ROLLBACK;

\o
SELECT 'Nothing was saved. Test companies left behind: ' || count(*) AS cleanup FROM companies WHERE name LIKE 'Check Co%';
