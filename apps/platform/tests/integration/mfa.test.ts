import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type MfaDeps,
  type RelyingParty,
  type WebAuthnLib,
  afterPassword,
  emailConfirm,
  emailStart,
  factors,
  loginPasskeyOptions,
  passkeyLogin,
  passkeyOptions,
  passkeyRegister,
  passkeyRegisterOptions,
  passkeyRemove,
  regenerateRecovery,
  resetUserMfa,
  securityOverview,
  sendLoginCode,
  setRequireMfa,
  totpConfirm,
  totpDisable,
  totpStart,
  verifyLogin,
} from '@/server/auth/mfa';
import { signup } from '@/server/auth/service';
import { type SessionUser, createSession, findSessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { MailMessage } from '@/server/mail/smtp';
import { currentStep, totpCode } from '@/server/security/otp';
import { hashPassword } from '@/server/security/password';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const RP: RelyingParty = { id: 'acme.meet.test', origin: 'https://acme.meet.test', name: 'Acme Meet' };

let clock = Date.UTC(2026, 10, 10, 12, 0, 0);
const mails: MailMessage[] = [];
let mailOn = true;

/** A browser stand-in: signs whatever challenge it is given with "its" passkey. */
const seen: { expectedChallenge?: string; requireUserVerification?: boolean }[] = [];
const webauthn: WebAuthnLib = {
  generateRegistrationOptions: (async (o: { rpID: string }) => ({
    challenge: `reg-${Math.random()}`,
    rp: { id: o.rpID, name: 'x' },
  })) as unknown as WebAuthnLib['generateRegistrationOptions'],
  verifyRegistrationResponse: (async (o: {
    expectedChallenge: string;
    response: { id: string; response: { challenge?: string } };
  }) => {
    seen.push({ expectedChallenge: o.expectedChallenge });
    if (o.response.response.challenge !== o.expectedChallenge) return { verified: false };
    return {
      verified: true,
      registrationInfo: {
        credential: {
          id: o.response.id,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    };
  }) as unknown as WebAuthnLib['verifyRegistrationResponse'],
  generateAuthenticationOptions: (async () => ({
    challenge: `auth-${Math.random()}`,
  })) as unknown as WebAuthnLib['generateAuthenticationOptions'],
  verifyAuthenticationResponse: (async (o: {
    expectedChallenge: string;
    requireUserVerification: boolean;
    credential: { counter: number };
    response: { response: { challenge?: string } };
  }) => {
    seen.push({ expectedChallenge: o.expectedChallenge, requireUserVerification: o.requireUserVerification });
    return {
      verified: o.response.response.challenge === o.expectedChallenge,
      authenticationInfo: { newCounter: o.credential.counter + 1 },
    };
  }) as unknown as WebAuthnLib['verifyAuthenticationResponse'],
};

const deps = (over: Partial<MfaDeps> = {}): MfaDeps => ({
  sql: db(),
  key: READY_AGENT_KEY,
  mailerFor: async () =>
    mailOn
      ? {
          from: 'meet@acme.test',
          async send(m) {
            mails.push(m);
          },
        }
      : null,
  webauthn,
  now: () => clock,
  ...over,
});

const passkeyAnswer = (id: string, challenge: string) =>
  ({ id, rawId: id, type: 'public-key', response: { challenge }, clientExtensionResults: {} }) as never;

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
  mails.length = 0;
  seen.length = 0;
  mailOn = true;
  clock += 10 * 60_000;
});

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

async function org(slug: string) {
  const { tenant, user } = await signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
  );
  return { tenant, admin: user };
}

async function member(tenantId: string, email = 'bia@acme.test') {
  const [m] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenantId}, ${email}, 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return m;
}

/** Turns the authenticator app on and returns its secret and the first recovery codes. */
async function withTotp(user: SessionUser) {
  const { secret, uri, qr } = await totpStart(deps(), { user }, 'Acme Meet');
  expect(uri).toContain(`secret=${secret}`);
  expect(qr.startsWith('<svg')).toBe(true);
  const { recoveryCodes } = await totpConfirm(deps(), { user }, totpCode(secret, currentStep(clock)), null);
  return { secret, recoveryCodes: recoveryCodes! };
}

const tick = (steps = 1) => {
  clock += steps * 30_000;
};

describe('two-step verification', () => {
  it('signs in with the password alone until a method is on, then asks for it', async () => {
    const { admin } = await org('acme');
    expect(await afterPassword(deps(), admin, false, RP, null)).toEqual({ kind: 'session' });
    const { secret, recoveryCodes } = await withTotp(admin);
    expect(recoveryCodes).toHaveLength(10);
    const [{ sealed }] = await sql<{ sealed: string }[]>`select totp_secret_sealed as sealed from user_mfa`;
    expect(sealed).not.toContain(secret);

    const next = await afterPassword(deps(), admin, false, RP, null);
    expect(next).toMatchObject({ kind: 'verify', methods: ['totp', 'recovery'], email: 'a••••@acme.test' });
    if (next.kind !== 'verify') throw new Error('expected verify');

    tick();
    const code = totpCode(secret, currentStep(clock));
    await expectAppError(
      verifyLogin(deps(), admin.tenantId, next.token, { method: 'totp', code: '000000' }, RP, null),
      401,
      /incorreto/,
    );
    const ok = await verifyLogin(deps(), admin.tenantId, next.token, { method: 'totp', code }, RP, null);
    expect(ok).toMatchObject({ user: { id: admin.id }, method: 'totp' });
    // The challenge is spent, and the same code never works twice.
    await expectAppError(
      verifyLogin(deps(), admin.tenantId, next.token, { method: 'totp', code }, RP, null),
      401,
      /expirou/,
    );
    const again = await afterPassword(deps(), admin, false, RP, null);
    if (again.kind !== 'verify') throw new Error('expected verify');
    await expectAppError(
      verifyLogin(deps(), admin.tenantId, again.token, { method: 'totp', code }, RP, null),
      401,
    );

    // Five wrong answers (the reused code was one) and the challenge is gone: back to the password.
    const wrong = () =>
      verifyLogin(deps(), admin.tenantId, again.token, { method: 'recovery', code: 'AAAAA-AAAAA' }, RP, null);
    for (let i = 0; i < 3; i++) await expectAppError(wrong(), 401, /incorreto/);
    await expectAppError(wrong(), 401, /Tentativas demais/);
    await expectAppError(
      verifyLogin(
        deps(),
        admin.tenantId,
        again.token,
        { method: 'recovery', code: recoveryCodes[0] },
        RP,
        null,
      ),
      401,
      /expirou/,
    );
    const failures = await sql`select count(*)::int as n from audit_log where action = 'auth.mfa_failed'`;
    expect(failures[0].n).toBeGreaterThanOrEqual(5);

    // A challenge from another organization's address is useless.
    const rival = await org('rival');
    const third = await afterPassword(deps(), admin, false, RP, null);
    if (third.kind !== 'verify') throw new Error('expected verify');
    await expectAppError(
      verifyLogin(
        deps(),
        rival.tenant.id,
        third.token,
        { method: 'totp', code: totpCode(secret, currentStep(clock) + 1) },
        RP,
        null,
      ),
      401,
    );
  });

  it('lets each recovery code in once, warns by e-mail and can issue new ones', async () => {
    const { admin } = await org('acme');
    const { recoveryCodes } = await withTotp(admin);
    const next = await afterPassword(deps(), admin, false, RP, null);
    if (next.kind !== 'verify') throw new Error('expected verify');
    const used = await verifyLogin(
      deps(),
      admin.tenantId,
      next.token,
      { method: 'recovery', code: recoveryCodes[2] },
      RP,
      null,
    );
    expect(used.recoveryLeft).toBe(9);
    expect(mails.at(-1)?.subject).toBe('Um código de recuperação foi usado');
    const again = await afterPassword(deps(), admin, false, RP, null);
    if (again.kind !== 'verify') throw new Error('expected verify');
    await expectAppError(
      verifyLogin(
        deps(),
        admin.tenantId,
        again.token,
        { method: 'recovery', code: recoveryCodes[2] },
        RP,
        null,
      ),
      401,
    );
    await expectAppError(regenerateRecovery(deps(), admin, 'senha-errada', null), 403, /Senha incorreta/);
    const fresh = await regenerateRecovery(deps(), admin, PASSWORD, null);
    expect(fresh).toHaveLength(10);
    expect((await factors(db(), admin.id)).recovery).toBe(10);
  });

  it('sends codes by e-mail at most once a minute and only to the user', async () => {
    const { admin } = await org('acme');
    const { token } = await emailStart(deps(), { user: admin }, 'Acme Meet', null);
    const code = /é: (\d{6})/.exec(mails.at(-1)!.text)![1];
    expect(mails.at(-1)).toMatchObject({
      to: 'admin@acme.test',
      subject: `${code} é o seu código de acesso — Acme Meet`,
    });
    await expectAppError(
      emailConfirm(deps(), { user: admin }, token, '999999' === code ? '111111' : '999999', null),
      401,
    );
    const { recoveryCodes } = await emailConfirm(deps(), { user: admin }, token, code, null);
    expect(recoveryCodes).toHaveLength(10);

    const next = await afterPassword(deps(), admin, false, RP, null);
    expect(next).toMatchObject({ kind: 'verify', methods: ['email', 'recovery'] });
    if (next.kind !== 'verify') throw new Error('expected verify');
    await sendLoginCode(deps(), admin.tenantId, next.token, 'Acme Meet');
    await expectAppError(sendLoginCode(deps(), admin.tenantId, next.token, 'Acme Meet'), 400, /minuto/);
    const loginCode = /é: (\d{6})/.exec(mails.at(-1)!.text)![1];
    clock += 61_000;
    await sendLoginCode(deps(), admin.tenantId, next.token, 'Acme Meet');
    const newest = /é: (\d{6})/.exec(mails.at(-1)!.text)![1];
    if (newest !== loginCode)
      await expectAppError(
        verifyLogin(deps(), admin.tenantId, next.token, { method: 'email', code: loginCode }, RP, null),
        401,
      );
    expect(
      await verifyLogin(deps(), admin.tenantId, next.token, { method: 'email', code: newest }, RP, null),
    ).toMatchObject({
      method: 'email',
    });
    // Without a way to send e-mail, the method is not offered.
    mailOn = false;
    expect(await afterPassword(deps(), admin, false, RP, null)).toMatchObject({ methods: ['recovery'] });
  });

  it('adds passkeys for this address, signs in with them (with or without the password) and removes them', async () => {
    const { admin } = await org('acme');
    const { token, options } = await passkeyRegisterOptions(deps(), { user: admin }, RP, null);
    const credentialId = 'credential-id-0123456789';
    await expectAppError(
      passkeyRegister(
        deps(),
        { user: admin },
        token,
        passkeyAnswer(credentialId, 'wrong'),
        'Notebook',
        RP,
        null,
      ),
      401,
    );
    const added = await passkeyRegister(
      deps(),
      { user: admin },
      token,
      passkeyAnswer(credentialId, options.challenge),
      'Notebook',
      RP,
      null,
    );
    expect(added.recoveryCodes).toHaveLength(10);
    expect(mails.at(-1)?.text).toContain('A passkey "Notebook" foi adicionada');

    const next = await afterPassword(deps(), admin, false, RP, null);
    expect(next).toMatchObject({
      kind: 'verify',
      methods: ['passkey', 'recovery'],
      passkeysElsewhere: false,
    });
    if (next.kind !== 'verify') throw new Error('expected verify');
    const auth = await loginPasskeyOptions(deps(), admin.tenantId, next.token, RP);
    const done = await verifyLogin(
      deps(),
      admin.tenantId,
      next.token,
      { method: 'passkey', response: passkeyAnswer(credentialId, auth.challenge) },
      RP,
      null,
    );
    expect(done.method).toBe('passkey');
    expect(seen.at(-1)?.requireUserVerification).toBe(false);

    // On another address of the organization the passkey is not usable, and the user is told.
    const elsewhere = await afterPassword(deps(), admin, false, { ...RP, id: 'meet.acme.com' }, null);
    expect(elsewhere).toMatchObject({ methods: ['recovery'], passkeysElsewhere: true });

    // Passwordless: the device must have checked the user.
    const pl = await passkeyOptions(deps(), RP, null);
    const user = await passkeyLogin(
      deps(),
      admin.tenantId,
      pl.token,
      passkeyAnswer(credentialId, pl.options.challenge),
      RP,
    );
    expect(user.id).toBe(admin.id);
    expect(seen.at(-1)?.requireUserVerification).toBe(true);
    const [{ counter }] = await sql<{ counter: string }[]>`select counter::text from webauthn_credentials`;
    expect(counter).toBe('2');
    const rival = await org('rival');
    const pl2 = await passkeyOptions(deps(), RP, null);
    await expectAppError(
      passkeyLogin(
        deps(),
        rival.tenant.id,
        pl2.token,
        passkeyAnswer(credentialId, pl2.options.challenge),
        RP,
      ),
      401,
    );

    const overview = await securityOverview(deps(), admin, RP);
    expect(overview.passkeys).toMatchObject([
      { id: credentialId, name: 'Notebook', here: true, backedUp: true },
    ]);
    await expectAppError(passkeyRemove(deps(), admin, credentialId, 'errada', null), 403);
    await passkeyRemove(deps(), admin, credentialId, PASSWORD, null);
    // With no method left, the recovery codes are gone too.
    expect(await factors(db(), admin.id)).toMatchObject({ passkeysAnywhere: 0, recovery: 0 });
  });

  it('can be required by the organization: setup at sign-in, no removing the last method, admin reset', async () => {
    const { tenant, admin } = await org('acme');
    await expectAppError(setRequireMfa(db(), admin, true, null), 400, /sua conta/);
    const { secret } = await withTotp(admin);
    await setRequireMfa(db(), admin, true, null);

    const bia = await member(tenant.id);
    await expectAppError(setRequireMfa(db(), bia, false, null), 403);
    const session = await createSession(db(), bia.id, {});
    expect(await findSessionUser(db(), session.token, tenant.id)).toMatchObject({ mfaSetupRequired: true });

    const next = await afterPassword(deps(), bia, true, RP, null);
    expect(next).toMatchObject({ kind: 'enroll', methods: ['passkey', 'totp', 'email'] });
    if (next.kind !== 'enroll') throw new Error('expected enroll');
    const enroller = { tenantId: tenant.id, token: next.token };
    const setup = await totpStart(deps(), enroller, 'Acme Meet');
    await expectAppError(totpConfirm(deps(), enroller, '000000', null), 401);
    const enrolled = await totpConfirm(deps(), enroller, totpCode(setup.secret, currentStep(clock)), null);
    expect(enrolled).toMatchObject({ user: { id: bia.id } });
    expect(enrolled.recoveryCodes).toHaveLength(10);
    expect(await findSessionUser(db(), session.token, tenant.id)).toMatchObject({ mfaSetupRequired: false });

    // The only method cannot go while the organization requires one.
    await expectAppError(totpDisable(deps(), bia, PASSWORD, null), 400, /exige/);

    // A lost phone: the admin clears Bia's methods and sessions.
    await expectAppError(resetUserMfa(deps(), admin, admin.id, null), 400);
    await expectAppError(resetUserMfa(deps(), bia, admin.id, null), 403);
    await resetUserMfa(deps(), admin, bia.id, null);
    expect(await factors(db(), bia.id)).toMatchObject({ totp: false, recovery: 0 });
    expect(await findSessionUser(db(), session.token, tenant.id)).toBeNull();
    expect(mails.at(-1)).toMatchObject({ to: 'bia@acme.test' });
    const audits = await sql<{ action: string }[]>`select action from audit_log order by id`;
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['mfa.totp_enabled', 'tenant.require_mfa', 'mfa.reset_by_admin']),
    );

    // Without the requirement, turning the app off works (with the password).
    await setRequireMfa(db(), admin, false, null);
    await expectAppError(totpDisable(deps(), admin, 'errada', null), 403);
    await totpDisable(deps(), admin, PASSWORD, null);
    expect(await afterPassword(deps(), admin, false, RP, null)).toEqual({ kind: 'session' });
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});
