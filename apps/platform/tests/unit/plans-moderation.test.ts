import { describe, expect, it } from 'vitest';
import { isUsersIdentity } from '@/server/moderation/service';
import { PLAN_LIMITS, capParticipants, effectiveLimits } from '@/server/plans';
import {
  brandingInput,
  domainInput,
  moderationInput,
  tenantAdminInput,
  updateRoomInput,
  updateUserInput,
} from '@/server/validation';

describe('plans', () => {
  it('falls back to the free plan for unknown names', () => {
    expect(effectiveLimits('gold', {})).toEqual(PLAN_LIMITS.free);
  });

  it('applies valid overrides and ignores invalid ones', () => {
    expect(effectiveLimits('free', { agents: true, maxRooms: null })).toMatchObject({
      agents: true,
      maxRooms: null,
    });
    expect(effectiveLimits('pro', { maxRooms: 'many' })).toEqual(PLAN_LIMITS.pro);
    expect(effectiveLimits('pro', { unknown: 1 })).toEqual(PLAN_LIMITS.pro);
    expect(effectiveLimits('enterprise', null)).toEqual(PLAN_LIMITS.enterprise);
  });

  it.each([
    [null, null, null],
    [10, null, 10],
    [null, 25, 25],
    [10, 25, 10],
    [50, 25, 25],
  ])('caps participants min(%j, %j) = %j', (a, b, expected) => {
    expect(capParticipants(a, b)).toBe(expected);
  });
});

describe('moderation helpers', () => {
  it('recognises identities issued to a user', () => {
    expect(isUsersIdentity('u-abc-123456', 'abc')).toBe(true);
    expect(isUsersIdentity('u-abcd-123456', 'abc')).toBe(false);
    expect(isUsersIdentity('g-abc', 'abc')).toBe(false);
  });
});

describe('admin validation', () => {
  it('requires something to change', () => {
    expect(updateRoomInput.safeParse({}).success).toBe(false);
    expect(updateUserInput.safeParse({}).success).toBe(false);
    expect(tenantAdminInput.safeParse({}).success).toBe(false);
    expect(updateRoomInput.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('accepts clearing a room password with null', () => {
    expect(updateRoomInput.parse({ password: null })).toEqual({ password: null });
  });

  it('validates branding', () => {
    expect(brandingInput.parse({ productName: ' Acme ', primaryColor: '#AABBCC', logoUrl: null })).toEqual({
      productName: 'Acme',
      primaryColor: '#aabbcc',
      logoUrl: null,
      defaultLocale: 'pt-BR',
    });
    expect(
      brandingInput.safeParse({
        productName: 'A',
        primaryColor: '#000000',
        logoUrl: null,
        defaultLocale: 'fr',
      }).success,
    ).toBe(false);
    expect(brandingInput.safeParse({ productName: 'A', primaryColor: 'red', logoUrl: null }).success).toBe(
      false,
    );
    expect(
      brandingInput.safeParse({ productName: 'A', primaryColor: '#000000', logoUrl: 'http://x.test/l.png' })
        .success,
    ).toBe(false);
    expect(
      brandingInput.safeParse({
        productName: 'A',
        primaryColor: '#000000',
        logoUrl: 'https://x.test/"onerror',
      }).success,
    ).toBe(false);
  });

  it.each(['reuniao.acme.com.br', 'meet.acme.io', 'a.co'])('accepts domain %j', (hostname) => {
    expect(domainInput.parse({ hostname: hostname.toUpperCase() }).hostname).toBe(hostname);
  });

  it.each(['localhost', 'acme', '-x.com', 'x_y.com', 'http://acme.com', '1.2.3.4'])(
    'rejects domain %j',
    (hostname) => {
      expect(domainInput.safeParse({ hostname }).success).toBe(false);
    },
  );

  it('knows the moderation actions', () => {
    expect(moderationInput.safeParse({ action: 'mute_all' }).success).toBe(true);
    expect(moderationInput.safeParse({ action: 'ban_forever' }).success).toBe(false);
  });
});
