import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '@/server/security/password';
import { RateLimiter } from '@/server/security/rate-limit';
import { hashToken, newToken } from '@/server/security/tokens';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('normalises unicode so visually identical passwords match', async () => {
    const hash = await hashPassword('cafe\u0301-senha-forte');
    expect(await verifyPassword('café-senha-forte', hash)).toBe(true);
  });

  it.each(['', 'bcrypt$x', 'scrypt$0$8$1$a$b', 'scrypt$999999999$8$1$a$b', 'scrypt$a$b$c$d$e'])(
    'rejects malformed stored hash %j',
    async (stored) => {
      expect(await verifyPassword('anything', stored)).toBe(false);
    },
  );

  it('dummy verification always fails', async () => {
    expect(await verifyAgainstDummy('whatever')).toBe(false);
  });
});

describe('session tokens', () => {
  it('are long, random and URL-safe', () => {
    const a = newToken();
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('hash deterministically to 32 bytes', () => {
    expect(hashToken('abc').equals(hashToken('abc'))).toBe(true);
    expect(hashToken('abc')).toHaveLength(32);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit within a window, then resets', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect([limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([true, true, false]);
    expect(limiter.take('other')).toBe(true);
    now = 1000;
    expect(limiter.take('k')).toBe(true);
  });

  it('sweeps expired keys when the table grows large', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 10, () => now);
    for (let i = 0; i < 10_001; i += 1) limiter.take(`k${i}`);
    now = 100;
    expect(limiter.take('fresh')).toBe(true);
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBe(1);
  });
});
