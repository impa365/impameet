import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { maskEmail } from '@/server/auth/mfa';
import {
  RECOVERY_CODES,
  base32Decode,
  base32Encode,
  currentStep,
  emailCodeHash,
  matchEmailCode,
  matchRecovery,
  newEmailCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryHash,
  totpCode,
  verifyTotp,
} from '@/server/security/otp';

/** RFC 6238 appendix B, SHA-1 (the 8-digit values, of which apps show the last 6). */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('authenticator codes (TOTP)', () => {
  it('matches the RFC 6238 test vectors, so every authenticator app agrees', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of RFC) expect(totpCode(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });

  it('accepts a clock 30 seconds off, never the same step twice, and nothing malformed', () => {
    const now = 1111111111_000;
    const step = currentStep(now);
    expect(verifyTotp(RFC_SECRET, '050471', 0, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, ' 050 471 ', 0, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, '050471', step, now)).toBeNull(); // already used
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), 0, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 0, now)).toBeNull();
  });

  it('makes 160-bit secrets, round-trips base32 and writes the otpauth link apps read', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const bytes = randomBytes(17);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Decode('gezd gnbv-gy3t q===').toString()).toBe('12345678');
    expect(() => base32Decode('0189')).toThrow();
    const uri = otpauthUri('Acme Meet', 'ana@acme.com', secret);
    expect(uri.startsWith('otpauth://totp/Acme%20Meet%3Aana%40acme.com?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      secret,
      issuer: 'Acme Meet',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});

describe('recovery and e-mail codes', () => {
  it('issues ten readable recovery codes that only work for their own user', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODES);
    expect(new Set(codes).size).toBe(RECOVERY_CODES);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    const hashes = codes.map((c) => recoveryHash('user-1', c));
    expect(matchRecovery('user-1', codes[3], hashes)).toBe(3);
    expect(matchRecovery('user-1', codes[3].toLowerCase().replace('-', ' '), hashes)).toBe(3);
    expect(matchRecovery('user-2', codes[3], hashes)).toBe(-1);
    expect(matchRecovery('user-1', 'AAAAA-AAAAA', hashes)).toBe(-1);
    expect(matchRecovery('user-1', 'curto', hashes)).toBe(-1);
  });

  it('binds e-mail codes to their challenge', () => {
    const code = newEmailCode();
    expect(code).toMatch(/^\d{6}$/);
    const a = randomBytes(32);
    const stored = emailCodeHash(a, code);
    expect(matchEmailCode(a, code, stored)).toBe(true);
    expect(matchEmailCode(a, ` ${code.slice(0, 3)} ${code.slice(3)} `, stored)).toBe(true);
    expect(matchEmailCode(randomBytes(32), code, stored)).toBe(false);
    expect(matchEmailCode(a, '000000' === code ? '111111' : '000000', stored)).toBe(false);
    expect(matchEmailCode(a, code, null)).toBe(false);
    expect(matchEmailCode(a, 'abc', stored)).toBe(false);
    expect(maskEmail('ana.silva@acme.com')).toBe('a••••••@acme.com');
    expect(maskEmail('jo@acme.com')).toBe('j••@acme.com');
  });
});
