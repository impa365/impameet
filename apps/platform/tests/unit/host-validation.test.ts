import { describe, expect, it } from 'vitest';
import { classifyHost, normaliseHost } from '@/server/tenants/host';
import {
  createRoomInput,
  firstIssue,
  joinInput,
  roomInvitesInput,
  roomSlug,
  signupInput,
  slugify,
  tenantSlug,
} from '@/server/validation';

const PLATFORM = 'meet.example.com';

describe('host classification', () => {
  it.each([
    ['meet.example.com', { kind: 'root' }],
    ['MEET.example.com:443', { kind: 'root' }],
    ['meet.example.com.', { kind: 'root' }],
    ['acme.meet.example.com', { kind: 'slug', slug: 'acme' }],
    ['a.b.meet.example.com', { kind: 'invalid' }],
    ['reuniao.cliente.com.br', { kind: 'domain', hostname: 'reuniao.cliente.com.br' }],
    ['', { kind: 'invalid' }],
    [null, { kind: 'invalid' }],
    ['bad_host!.com', { kind: 'invalid' }],
    ['-leading.com', { kind: 'invalid' }],
  ])('%j -> %j', (host, expected) => {
    expect(classifyHost(host, PLATFORM)).toEqual(expected);
  });

  it('rejects absurdly long hosts', () => {
    expect(normaliseHost(`${'a'.repeat(60)}.`.repeat(5) + 'com')).toBeNull();
  });

  it('does not treat a lookalike suffix as a subdomain', () => {
    expect(classifyHost('evilmeet.example.com', PLATFORM)).toEqual({
      kind: 'domain',
      hostname: 'evilmeet.example.com',
    });
  });
});

describe('validation', () => {
  it.each(['acme', 'a', 'acme-2026', 'x1'])('accepts tenant slug %j', (s) => {
    expect(tenantSlug.parse(s)).toBe(s);
  });

  it.each(['-acme', 'acme-', 'ac me', 'ação', 'a'.repeat(41), 'admin', 'www', 'API'])(
    'rejects tenant slug %j',
    (s) => {
      expect(tenantSlug.safeParse(s).success).toBe(false);
    },
  );

  it('lower-cases slugs', () => {
    expect(roomSlug.parse('Sala-1')).toBe('sala-1');
  });

  it('validates a complete signup and normalises the e-mail', () => {
    const parsed = signupInput.parse({
      organization: ' Acme ',
      slug: 'acme',
      name: 'Ana',
      email: ' ANA@Acme.com ',
      password: 'uma-senha-forte',
    });
    expect(parsed).toMatchObject({ organization: 'Acme', email: 'ana@acme.com' });
  });

  it('explains a short password in Portuguese', () => {
    const r = signupInput.safeParse({
      organization: 'Acme',
      slug: 'acme',
      name: 'Ana',
      email: 'ana@acme.com',
      password: 'curta',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toMatch(/10 caracteres/);
  });

  it('applies room defaults and bounds', () => {
    expect(createRoomInput.parse({ name: 'Daily' })).toEqual({
      name: 'Daily',
      allowGuests: true,
      access: 'trusted',
      boardPolicy: 'everyone',
      pollsPolicy: 'everyone',
      agentEnabled: false,
    });
    expect(createRoomInput.safeParse({ name: 'x', maxParticipants: 1 }).success).toBe(false);
    expect(createRoomInput.safeParse({ name: 'x', password: '123' }).success).toBe(false);
  });

  it('requires a display name to join', () => {
    expect(joinInput.safeParse({ displayName: '   ' }).success).toBe(false);
  });

  it.each([
    ['Reunião de Vendas!', 'reuniao-de-vendas'],
    ['  --Olá   Mundo--  ', 'ola-mundo'],
    ['!!!', ''],
    ['a'.repeat(70), 'a'.repeat(64)],
  ])('slugify(%j) = %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe('room invites', () => {
  it('folds case and duplicates, and rejects bad e-mails', () => {
    expect(roomInvitesInput.parse({ emails: ['Ana@X.com', 'ana@x.com', ' bia@x.com '] }).emails).toEqual([
      'ana@x.com',
      'bia@x.com',
    ]);
    expect(roomInvitesInput.safeParse({ emails: ['não é e-mail'] }).success).toBe(false);
  });
});
