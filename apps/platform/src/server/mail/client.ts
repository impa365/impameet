import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { parseMasterKey } from '../security/secrets';
import type { MailDeps } from './service';

let key: Buffer | null | undefined;

export function mailDeps(): MailDeps {
  const cfg = config();
  key ??= cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null;
  return {
    sql: db(),
    key,
    legacy: cfg.smtpUrl && cfg.mailFrom ? { url: cfg.smtpUrl, from: cfg.mailFrom } : null,
  };
}
