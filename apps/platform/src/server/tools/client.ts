import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { masterKey } from '../integrations/client';
import type { ToolDeps } from './service';

let privateHosts: ReadonlySet<string> | undefined;

export function toolDeps(): ToolDeps {
  privateHosts ??= new Set(config().toolsPrivateHosts);
  return { sql: db(), key: masterKey(), net: { privateHosts } };
}
