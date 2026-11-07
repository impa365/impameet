import postgres from 'postgres';
import { migrate } from '../../scripts/migrate.mjs';

export type TestSql = postgres.Sql;

/** A freshly migrated, empty database for each test file. */
export async function freshDatabase(): Promise<TestSql> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe('drop schema public cascade; create schema public;');
  await admin.end();
  await migrate(url, () => {});
  return postgres(url, { max: 4, onnotice: () => {} });
}
