import 'server-only';
import postgres from 'postgres';
import { config } from './config';

export type Sql = postgres.Sql;

const globalForDb = globalThis as unknown as { __impaSql?: Sql };

/** One pool per process (kept across dev hot reloads). */
export function db(): Sql {
  globalForDb.__impaSql ??= postgres(config().databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return globalForDb.__impaSql;
}
