// Runs one or more .sql files against MIGRATE_DATABASE_URL (the owner connection).
// Usage: tsx scripts/apply-sql.ts prisma/constraints.sql prisma/grants.sql
import { readFileSync } from 'node:fs';
import pg from 'pg';

try {
  process.loadEnvFile('.env'); // does not override variables already set
} catch {
  // no .env file: rely on the real environment
}

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) throw new Error('MIGRATE_DATABASE_URL is not set');

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('Pass at least one .sql file');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of files) {
    await client.query(readFileSync(file, 'utf8'));
    console.log(`applied ${file}`);
  }
} finally {
  await client.end();
}
