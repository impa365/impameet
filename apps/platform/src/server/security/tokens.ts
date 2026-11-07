import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Session tokens are stored only as SHA-256 hashes: a database leak does not leak sessions. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
