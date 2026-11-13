import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { parseMasterKey } from '../security/secrets';
import type { StorageDeps } from './service';

let deps: StorageDeps | undefined;

export function storageDeps(): StorageDeps {
  if (deps) return deps;
  const cfg = config();
  deps = {
    sql: db(),
    key: cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null,
    recordingsDir: cfg.recordingsDir ?? null,
    platformUrl: `${cfg.secureCookies ? 'https' : 'http'}://${cfg.platformDomain}`,
  };
  return deps;
}
