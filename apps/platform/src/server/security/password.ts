import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** `scrypt$N$r$p$salt$hash` (base64url), self-describing so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 2 ** 20) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await derive(password, Buffer.from(parts[4], 'base64url'), n, r, p);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHash: Promise<string> | undefined;
/** Burns the same time as a real check, so unknown e-mails are not distinguishable by timing. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
  return false;
}
