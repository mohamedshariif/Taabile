import { spawnSync } from 'node:child_process';

try {
  process.loadEnvFile('.env'); // Node 20.12+; does not override variables already set
} catch {
  // no .env file: rely on the real environment
}

const owner = process.env.MIGRATE_DATABASE_URL;
if (!owner) {
  console.error('MIGRATE_DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const result = spawnSync('npx', ['prisma', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DATABASE_URL: owner },
});
process.exit(result.status ?? 1);
