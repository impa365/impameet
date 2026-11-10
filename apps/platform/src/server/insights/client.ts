import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { parseMasterKey } from '../security/secrets';
import { mailDeps } from '../mail/client';
import { tenantMailer } from '../mail/service';
import { openAiComplete } from './llm';
import type { ReportDeps } from './reports';

let key: Buffer | null | undefined;
let privateHosts: ReadonlySet<string> | undefined;

export function reportDeps(): ReportDeps {
  const cfg = config();
  key ??= cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null;
  privateHosts ??= new Set(cfg.toolsPrivateHosts);
  return {
    sql: db(),
    key,
    net: { privateHosts },
    complete: openAiComplete(),
    mailerFor: (tenantId) => tenantMailer(mailDeps(), tenantId),
  };
}
