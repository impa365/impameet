import { describe, expect, it } from 'vitest';
import { hashToken } from '@/server/security/tokens';

describe('api key token hashing', () => {
  it('hashes the full secret so a DB leak does not reveal the key', () => {
    const token = 'impa_' + 'a'.repeat(43);
    const a = hashToken(token);
    const b = hashToken(token);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(hashToken(token + 'x'))).toBe(false);
    expect(a.length).toBe(32);
  });
});
