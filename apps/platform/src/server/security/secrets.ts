import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secrets at rest (provider API keys): AES-256-GCM with a master key that lives outside the
 * database (a Docker/Swarm secret). The associated data binds each value to its row, so a
 * ciphertext copied to another organization or record does not decrypt.
 */

const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export function parseMasterKey(raw: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new Error('encryption key must be 32 bytes, base64-encoded');
  return key;
}

export function sealSecret(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64'));
  return PREFIX + parts.join('.');
}

export function openSecret(key: Buffer, sealed: string, aad: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error('not a sealed secret');
  const [iv, tag, body] = sealed
    .slice(PREFIX.length)
    .split('.')
    .map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !body || iv.length !== IV_BYTES) throw new Error('malformed sealed secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** What the panel may show of a key: never more than its last 4 characters. */
export function secretHint(plain: string): string {
  const value = plain.trim();
  return value.length >= 12 ? `••••${value.slice(-4)}` : '••••';
}
