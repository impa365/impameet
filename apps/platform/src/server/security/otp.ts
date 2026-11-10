/**
 * One-time codes: TOTP for authenticator apps (RFC 6238: HMAC-SHA1, 30 s, 6 digits, the
 * format every app reads), one-time recovery codes, and the 6-digit codes sent by e-mail.
 * Codes are compared in constant time and stored only as hashes.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** One step either side: a phone clock up to 30 seconds off still works. */
const TOTP_WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, as RFC 4226 recommends. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The step a code belongs to, or null. A step at or before `lastStep` is refused, so a code
 * seen over someone's shoulder cannot be used a second time.
 */
export function verifyTotp(secret: string, code: string, lastStep: number, now = Date.now()): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const here = currentStep(now);
  for (let step = here - TOTP_WINDOW; step <= here + TOTP_WINDOW; step++)
    if (step > lastStep && sameText(totpCode(secret, step), typed)) return step;
  return null;
}

/** The link authenticator apps read from the QR code. */
export function otpauthUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- Recovery codes ---------------------------------------------------------------------

export const RECOVERY_CODES = 10;

/** "K7Q2M-WX9PD": 50 bits each, easy to read and type. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

const normalizeRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '');

/** Bound to the user, so the same code means nothing for anyone else. */
export const recoveryHash = (userId: string, code: string): Buffer =>
  createHash('sha256')
    .update(`recovery:${userId}:${normalizeRecovery(code)}`)
    .digest();

/** Which stored hash a typed code matches (-1: none). */
export function matchRecovery(userId: string, code: string, hashes: Buffer[]): number {
  if (normalizeRecovery(code).length !== 10) return -1;
  const typed = recoveryHash(userId, code);
  let found = -1;
  hashes.forEach((h, i) => {
    if (h.length === typed.length && timingSafeEqual(h, typed)) found = i;
  });
  return found;
}

// --- Codes by e-mail --------------------------------------------------------------------

export const newEmailCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const emailCodeHash = (challengeId: Buffer, code: string): Buffer =>
  createHash('sha256')
    .update(challengeId)
    .update(`:${code.replace(/\s/g, '')}`)
    .digest();

export function matchEmailCode(challengeId: Buffer, code: string, stored: Buffer | null): boolean {
  if (!stored || !/^\d{6}$/.test(code.replace(/\s/g, ''))) return false;
  const typed = emailCodeHash(challengeId, code);
  return typed.length === stored.length && timingSafeEqual(typed, stored);
}
