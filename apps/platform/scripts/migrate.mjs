// Applies migrations/*.sql in order, each in its own transaction, exactly once.
// A Postgres advisory lock keeps concurrent starts (several replicas) from racing.
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const LOCK_ID = 72_117_365;
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function databaseUrl() {
  const file = process.env.DATABASE_URL_FILE;
  const url = file ? readFileSync(file, 'utf8').trim() : process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('set DATABASE_URL_FILE (preferred) or DATABASE_URL');
  return url;
}

/** The database may still be starting (fresh deploys, restarts): wait for it, bounded. */
async function waitForDatabase(sql, log, attempts = 30, delayMs = 2000) {
  for (let i = 1; ; i += 1) {
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log(`database not ready (${err.code ?? err.message}), retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function migrate(
  url = databaseUrl(),
  log = console.log,
  { attempts = 30, delayMs = 2000 } = {},
) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForDatabase(sql, log, attempts, delayMs);
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    await sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      log(`migration applied: ${file}`);
    }
    await sql`select pg_advisory_unlock(${LOCK_ID})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().catch((err) => {
    console.error('migration failed:', err.message);
    process.exit(1);
  });
}
