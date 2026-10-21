-- One-time setup for a LOCAL PostgreSQL (no Docker). Run as your Postgres superuser:
--   psql -d postgres -f scripts/local-db.sql
-- Change both passwords here and in .env if you like.

-- The owner runs migrations. CREATEDB is required: `prisma migrate dev` makes a temporary shadow database.
CREATE ROLE taabile LOGIN PASSWORD 'taabile_dev' CREATEDB;

-- The API connects as this user. It can never edit or delete ledgers.
CREATE ROLE taabile_app LOGIN PASSWORD 'taabile_app_dev';

CREATE DATABASE taabile OWNER taabile;
