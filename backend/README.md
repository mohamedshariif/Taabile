# Taabile backend

Express + TypeScript + Prisma + PostgreSQL. Local PostgreSQL, no Docker.
Needs Node 20.12 or newer (Node 22 recommended) and a running PostgreSQL.

## First run (macOS)

```bash
cd ~/Projects/taabile/backend

# 1. Create the database and its two users (once)
psql -d postgres -f scripts/local-db.sql

# 2. Settings
cp .env.example .env
sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" .env

# 3. Install, then build the database
npm install
npm run db:generate
npm run db:migrate -- --name init
npm run db:setup

# 4. Check everything
npm test
npm run dev        # then, in another terminal: curl http://localhost:4000/health
```

After any change to `prisma/schema.prisma`:

```bash
npm run db:migrate -- --name what_changed
npm run db:setup      # re-applies the ledger rules and permissions to new tables
```

## Two database users (on purpose)

| Variable | User | Used for |
| --- | --- | --- |
| `MIGRATE_DATABASE_URL` | `taabile` (owner) | Migrations and `db:setup` only |
| `DATABASE_URL` | `taabile_app` | The API at runtime. Cannot edit or delete ledgers, and sees only one company's rows |

Never commit `.env`.

## Layout

- `prisma/schema.prisma`: the 47 tables
- `prisma/constraints.sql`: balanced journals, append-only ledgers, locked periods, no negative stock, row-level security
- `prisma/grants.sql`: what the API user may and may not do
- `scripts/local-db.sql`: one-time local database and user creation
- `src/accounting/`: chart of accounts template and posting rules
- `src/auth/permissions.ts`: permission list and role presets
- `src/db/client.ts`: `withTenant()`, which wraps every business event in one transaction for one company
- `tests/`: unit tests and database invariant tests (they use an in-memory database and never touch yours)
