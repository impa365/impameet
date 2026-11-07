import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { AppError } from '../errors';
import { parseMasterKey } from '../security/secrets';
import type { IntegrationDeps } from './service';

let key: Buffer | undefined;

/** Integrations need the master key; without it the feature reports that it is not set up. */
export function masterKey(): Buffer {
  const raw = config().encryptionKey;
  if (!raw) {
    throw new AppError(
      501,
      'encryption_disabled',
      'A criptografia de chaves não está configurada neste servidor',
    );
  }
  key ??= parseMasterKey(raw);
  return key;
}

export function integrationDeps(): IntegrationDeps {
  return { sql: db(), key: masterKey() };
}
