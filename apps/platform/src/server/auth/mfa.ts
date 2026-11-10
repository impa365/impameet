/**
 * Two-step verification. After the right password, signing in becomes a short-lived challenge
 * (10 minutes, 5 tries) that one second factor completes: a code from an authenticator app,
 * a passkey, a code by e-mail, or a one-time recovery code. Organizations can require it; then
 * whoever has no factor sets one up before getting a session. Every change is audited and the
 * user is told by e-mail.
 */
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import QRCode from 'qrcode';
import { audit } from '../audit';
import type { Sql } from '../db';
import { AppError, badRequest, forbidden, notFound, tooManyRequests, unauthorized } from '../errors';
import type { Mailer } from '../mail/smtp';
import {
  RECOVERY_CODES,
  emailCodeHash,
  matchEmailCode,
  matchRecovery,
  newEmailCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  recoveryHash,
  verifyTotp,
} from '../security/otp';
import { verifyPassword } from '../security/password';
import { RateLimiter } from '../security/rate-limit';
import { openSecret, sealSecret } from '../security/secrets';
import { hashToken, newToken } from '../security/tokens';
import type { SessionUser } from './session';

export type MfaMethod = 'totp' | 'passkey' | 'email' | 'recovery';

/** Where passkeys live: the address the user is on. */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const realWebAuthn: WebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export interface MfaDeps {
  sql: Sql;
  /** Needed to seal authenticator secrets; without it only passkeys and e-mail work. */
  key: Buffer | null;
  mailerFor: (tenantId: string) => Promise<Mailer | null>;
  webauthn?: WebAuthnLib;
  now?: () => number;
}

const CHALLENGE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const EMAIL_RESEND_MS = 60_000;
const MAX_EMAIL_SENDS = 5;
const PENDING_TOTP_MINUTES = 15;
const perAccount = new RateLimiter(10, 10 * 60_000);

const totpAad = (userId: string) => `totp:${userId}`;
const nowOf = (deps: MfaDeps) => (deps.now ? deps.now() : Date.now());

// --- Factors ----------------------------------------------------------------------------

interface MfaRow {
  totpSecretSealed: string | null;
  totpEnabledAt: Date | null;
  totpLastStep: string;
  totpPendingSealed: string | null;
  totpPendingAt: Date | null;
  emailEnabledAt: Date | null;
  recoveryHashes: Buffer[];
  recoveryCreatedAt: Date | null;
}

async function mfaRow(sql: Sql, userId: string): Promise<MfaRow | null> {
  const [row] = await sql<MfaRow[]>`
    select totp_secret_sealed as "totpSecretSealed", totp_enabled_at as "totpEnabledAt",
           totp_last_step::text as "totpLastStep", totp_pending_sealed as "totpPendingSealed",
           totp_pending_at as "totpPendingAt", email_enabled_at as "emailEnabledAt",
           recovery_hashes as "recoveryHashes", recovery_created_at as "recoveryCreatedAt"
    from user_mfa where user_id = ${userId}`;
  return row ?? null;
}

async function ensureRow(sql: Sql, userId: string) {
  await sql`insert into user_mfa (user_id) values (${userId}) on conflict (user_id) do nothing`;
}

export interface Factors {
  totp: boolean;
  email: boolean;
  /** Passkeys made on this address (the only ones the browser can use here). */
  passkeys: number;
  /** All passkeys, on any of the organization's addresses. */
  passkeysAnywhere: number;
  recovery: number;
}

export async function factors(sql: Sql, userId: string, rpId?: string): Promise<Factors> {
  const row = await mfaRow(sql, userId);
  const [{ here, anywhere }] = await sql<{ here: number; anywhere: number }[]>`
    select count(*) filter (where rp_id = ${rpId ?? ''})::int as here, count(*)::int as anywhere
    from webauthn_credentials where user_id = ${userId}`;
  return {
    totp: Boolean(row?.totpEnabledAt),
    email: Boolean(row?.emailEnabledAt),
    passkeys: here,
    passkeysAnywhere: anywhere,
    recovery: row?.recoveryHashes.length ?? 0,
  };
}

const hasFactor = (f: Factors) => f.totp || f.email || f.passkeysAnywhere > 0;

/** Recovery codes come with the first factor (and are shown only then). */
async function firstRecoveryCodes(sql: Sql, userId: string): Promise<string[] | undefined> {
  const row = await mfaRow(sql, userId);
  if (row && row.recoveryHashes.length > 0) return undefined;
  return issueRecoveryCodes(sql, userId);
}

async function issueRecoveryCodes(sql: Sql, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await ensureRow(sql, userId);
  await sql`update user_mfa set recovery_hashes = ${codes.map((c) => recoveryHash(userId, c))}::bytea[],
            recovery_created_at = now(), updated_at = now() where user_id = ${userId}`;
  return codes;
}

// --- Challenges -------------------------------------------------------------------------

interface ChallengeRow {
  idHash: Buffer;
  userId: string | null;
  purpose: 'login' | 'enroll' | 'passkey' | 'account';
  webauthnChallenge: string | null;
  emailCodeHash: Buffer | null;
  emailSentAt: Date | null;
  emailSends: number;
  attempts: number;
}

async function createChallenge(
  sql: Sql,
  userId: string | null,
  purpose: ChallengeRow['purpose'],
  ip: string | null,
  now: number,
): Promise<{ token: string; idHash: Buffer }> {
  const token = newToken();
  const idHash = hashToken(token);
  await dropExpired(sql, now);
  await sql`
    insert into auth_challenges (id_hash, user_id, purpose, ip, expires_at)
    values (${idHash}, ${userId}, ${purpose}, ${ip}, ${new Date(now + CHALLENGE_MINUTES * 60_000)})`;
  return { token, idHash };
}

async function dropExpired(sql: Sql, now: number) {
  await sql`delete from auth_challenges where expires_at < ${new Date(now)}`;
}

async function loadChallenge(
  sql: Sql,
  token: string,
  purposes: ChallengeRow['purpose'][],
  userId?: string,
  now = Date.now(),
): Promise<ChallengeRow> {
  if (!token || token.length > 100) throw unauthorized('A verificação expirou. Entre de novo.');
  const [row] = await sql<ChallengeRow[]>`
    select id_hash as "idHash", user_id as "userId", purpose, webauthn_challenge as "webauthnChallenge",
           email_code_hash as "emailCodeHash", email_sent_at as "emailSentAt", email_sends as "emailSends",
           attempts
    from auth_challenges
    where id_hash = ${hashToken(token)} and expires_at > ${new Date(now)} and purpose in ${sql(purposes)}`;
  if (!row || (userId && row.userId !== userId)) throw unauthorized('A verificação expirou. Entre de novo.');
  return row;
}

/** A wrong answer: counted, and after five the challenge is gone (back to the password). */
async function failedAttempt(sql: Sql, c: ChallengeRow): Promise<never> {
  if (c.attempts + 1 >= MAX_ATTEMPTS) {
    await sql`delete from auth_challenges where id_hash = ${c.idHash}`;
    throw unauthorized('Tentativas demais. Entre de novo.');
  }
  await sql`update auth_challenges set attempts = attempts + 1 where id_hash = ${c.idHash}`;
  throw unauthorized('Código incorreto');
}

const consume = (sql: Sql, c: ChallengeRow) => sql`delete from auth_challenges where id_hash = ${c.idHash}`;

// --- Signing in -------------------------------------------------------------------------

export type AfterPassword =
  | { kind: 'session' }
  | {
      kind: 'verify';
      token: string;
      methods: MfaMethod[];
      email: string;
      /** The user's passkeys were made on another of the organization's addresses. */
      passkeysElsewhere: boolean;
    }
  | { kind: 'enroll'; token: string; methods: Exclude<MfaMethod, 'recovery'>[] };

/** Masks the address a code goes to: "ana@acme.com" → "a••@acme.com". */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.min(6, Math.max(2, local.length - 1)))}@${domain}`;
};

/** What happens once the password is right: a session, a second step, or setting one up. */
export async function afterPassword(
  deps: MfaDeps,
  user: SessionUser,
  requireMfa: boolean,
  rp: RelyingParty,
  ip: string | null,
): Promise<AfterPassword> {
  const f = await factors(deps.sql, user.id, rp.id);
  const mailer = await deps.mailerFor(user.tenantId).catch(() => null);
  if (hasFactor(f)) {
    const methods: MfaMethod[] = [];
    if (f.passkeys > 0) methods.push('passkey');
    if (f.totp) methods.push('totp');
    if (f.email && mailer) methods.push('email');
    if (f.recovery > 0) methods.push('recovery');
    const { token } = await createChallenge(deps.sql, user.id, 'login', ip, nowOf(deps));
    return {
      kind: 'verify',
      token,
      methods,
      email: maskEmail(user.email),
      passkeysElsewhere: f.passkeys === 0 && f.passkeysAnywhere > 0,
    };
  }
  if (!requireMfa) return { kind: 'session' };
  const methods: Exclude<MfaMethod, 'recovery'>[] = ['passkey'];
  if (deps.key) methods.push('totp');
  if (mailer) methods.push('email');
  const { token } = await createChallenge(deps.sql, user.id, 'enroll', ip, nowOf(deps));
  return { kind: 'enroll', token, methods };
}

async function challengeUser(sql: Sql, c: ChallengeRow, tenantId: string): Promise<SessionUser> {
  const [user] = await sql<SessionUser[]>`
    select id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"
    from users where id = ${c.userId} and tenant_id = ${tenantId} and status = 'active'`;
  if (!user) throw unauthorized('A verificação expirou. Entre de novo.');
  return user;
}

const limited = (userId: string) => {
  if (!perAccount.take(`mfa:${userId}`)) throw tooManyRequests();
};

/** Sends (or re-sends, once a minute) the sign-in code to the user's own address. */
export async function sendLoginCode(
  deps: MfaDeps,
  tenantId: string,
  token: string,
  product: string,
): Promise<{ email: string }> {
  const c = await loadChallenge(deps.sql, token, ['login', 'enroll'], undefined, nowOf(deps));
  const user = await challengeUser(deps.sql, c, tenantId);
  if (c.purpose === 'login' && !(await factors(deps.sql, user.id)).email)
    throw badRequest('O código por e-mail não está ligado nesta conta');
  await sendCode(deps, c, user, product);
  return { email: maskEmail(user.email) };
}

async function sendCode(deps: MfaDeps, c: ChallengeRow, user: SessionUser, product: string) {
  const now = nowOf(deps);
  if (c.emailSentAt && now - c.emailSentAt.getTime() < EMAIL_RESEND_MS)
    throw badRequest('Espere um minuto para pedir outro código');
  if (c.emailSends >= MAX_EMAIL_SENDS) throw tooManyRequests();
  const mailer = await deps.mailerFor(user.tenantId);
  if (!mailer) throw badRequest('Esta organização não envia e-mails');
  const code = newEmailCode();
  await deps.sql`update auth_challenges set email_code_hash = ${emailCodeHash(c.idHash, code)},
                 email_sent_at = ${new Date(now)}, email_sends = email_sends + 1, attempts = 0
                 where id_hash = ${c.idHash}`;
  await mailer.send({
    to: user.email,
    subject: `${code} é o seu código de acesso — ${product}`,
    text:
      `Olá, ${user.name}.\n\nSeu código de acesso ao ${product} é: ${code}\n\n` +
      `Ele vale por ${CHALLENGE_MINUTES} minutos. Se não foi você que tentou entrar, troque sua senha.`,
  });
}

/** Options for the browser to sign the sign-in challenge with one of the user's passkeys. */
export async function loginPasskeyOptions(deps: MfaDeps, tenantId: string, token: string, rp: RelyingParty) {
  const c = await loadChallenge(deps.sql, token, ['login'], undefined, nowOf(deps));
  const user = await challengeUser(deps.sql, c, tenantId);
  const creds = await deps.sql<{ id: string; transports: string[] }[]>`
    select id, transports from webauthn_credentials where user_id = ${user.id} and rp_id = ${rp.id}`;
  if (creds.length === 0) throw badRequest('Nenhuma passkey desta conta neste endereço');
  const options = await (deps.webauthn ?? realWebAuthn).generateAuthenticationOptions({
    rpID: rp.id,
    allowCredentials: creds.map((k) => ({ id: k.id, transports: k.transports })),
    userVerification: 'preferred',
  });
  await deps.sql`update auth_challenges set webauthn_challenge = ${options.challenge} where id_hash = ${c.idHash}`;
  return options;
}

interface CredentialRow {
  id: string;
  userId: string;
  publicKey: Buffer;
  counter: string;
  transports: string[];
}

async function checkAssertion(
  deps: MfaDeps,
  c: ChallengeRow,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
  userId: string | null,
  requireUserVerification: boolean,
): Promise<CredentialRow> {
  const [cred] = await deps.sql<CredentialRow[]>`
    select id, user_id as "userId", public_key as "publicKey", counter::text as counter, transports
    from webauthn_credentials where id = ${String(response.id)} and rp_id = ${rp.id}
      ${userId ? deps.sql`and user_id = ${userId}` : deps.sql``}`;
  if (!cred || !c.webauthnChallenge) return failedAttempt(deps.sql, c);
  let ok = false;
  let counter = Number(cred.counter);
  try {
    const result = await (deps.webauthn ?? realWebAuthn).verifyAuthenticationResponse({
      response,
      expectedChallenge: c.webauthnChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.publicKey),
        counter,
        transports: cred.transports as never,
      },
      requireUserVerification,
    });
    ok = result.verified;
    counter = result.authenticationInfo.newCounter;
  } catch {
    ok = false;
  }
  if (!ok) return failedAttempt(deps.sql, c);
  await deps.sql`update webauthn_credentials set counter = ${counter}, last_used_at = now() where id = ${cred.id}`;
  return cred;
}

export type SecondStep =
  | { method: 'totp' | 'recovery' | 'email'; code: string }
  | { method: 'passkey'; response: AuthenticationResponseJSON };

/** The second step of signing in. Returns the user to open a session for. */
export async function verifyLogin(
  deps: MfaDeps,
  tenantId: string,
  token: string,
  step: SecondStep,
  rp: RelyingParty,
  ip: string | null,
): Promise<{ user: SessionUser; method: MfaMethod; recoveryLeft?: number }> {
  const c = await loadChallenge(deps.sql, token, ['login'], undefined, nowOf(deps));
  const user = await challengeUser(deps.sql, c, tenantId);
  limited(user.id);
  const fail = async () => {
    await audit(deps.sql, {
      tenantId,
      actorId: user.id,
      action: 'auth.mfa_failed',
      meta: { method: step.method },
      ip,
    });
    return failedAttempt(deps.sql, c);
  };
  let recoveryLeft: number | undefined;
  if (step.method === 'totp') {
    const row = await mfaRow(deps.sql, user.id);
    if (!row?.totpEnabledAt || !row.totpSecretSealed || !deps.key) return fail();
    const secret = openSecret(deps.key, row.totpSecretSealed, totpAad(user.id));
    const matched = verifyTotp(secret, step.code, Number(row.totpLastStep), nowOf(deps));
    if (matched === null) return fail();
    const used = await deps.sql`update user_mfa set totp_last_step = ${matched}
                                where user_id = ${user.id} and totp_last_step < ${matched}`;
    if (used.count === 0) return fail();
  } else if (step.method === 'recovery') {
    const row = await mfaRow(deps.sql, user.id);
    const i = row ? matchRecovery(user.id, step.code, row.recoveryHashes) : -1;
    if (!row || i < 0) return fail();
    const left = row.recoveryHashes.filter((_, j) => j !== i);
    await deps.sql`update user_mfa set recovery_hashes = ${left}::bytea[], updated_at = now()
                   where user_id = ${user.id}`;
    recoveryLeft = left.length;
    await notify(deps, user, 'Um código de recuperação foi usado', [
      `Um código de recuperação foi usado para entrar na sua conta. Restam ${left.length} de ${RECOVERY_CODES}.`,
      'Se não foi você, troque sua senha e gere códigos novos agora.',
    ]);
  } else if (step.method === 'email') {
    if (!matchEmailCode(c.idHash, step.code, c.emailCodeHash)) return fail();
  } else if ('response' in step) {
    await checkAssertion(deps, c, step.response, rp, user.id, false);
  } else return fail();
  await consume(deps.sql, c);
  return { user, method: step.method, recoveryLeft };
}

/** "Entrar com passkey": no password, the passkey alone (with the device's own check). */
export async function passkeyOptions(deps: MfaDeps, rp: RelyingParty, ip: string | null) {
  const { token, idHash } = await createChallenge(deps.sql, null, 'passkey', ip, nowOf(deps));
  const options = await (deps.webauthn ?? realWebAuthn).generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'required',
  });
  await deps.sql`update auth_challenges set webauthn_challenge = ${options.challenge} where id_hash = ${idHash}`;
  return { token, options };
}

export async function passkeyLogin(
  deps: MfaDeps,
  tenantId: string,
  token: string,
  response: AuthenticationResponseJSON,
  rp: RelyingParty,
): Promise<SessionUser> {
  const c = await loadChallenge(deps.sql, token, ['passkey'], undefined, nowOf(deps));
  const cred = await checkAssertion(deps, c, response, rp, null, true);
  await consume(deps.sql, c);
  return challengeUser(deps.sql, { ...c, userId: cred.userId }, tenantId);
}

// --- Setting factors up (signed in, or while signing in when the organization requires it) --

/** Who is setting up: a signed-in user, or the one in an "enroll" sign-in challenge. */
export type Enroller = { user: SessionUser } | { tenantId: string; token: string };

async function enrollerUser(
  deps: MfaDeps,
  who: Enroller,
): Promise<{ user: SessionUser; challenge?: ChallengeRow }> {
  if ('user' in who) return { user: who.user };
  const c = await loadChallenge(deps.sql, who.token, ['enroll'], undefined, nowOf(deps));
  return { user: await challengeUser(deps.sql, c, who.tenantId), challenge: c };
}

export async function totpStart(
  deps: MfaDeps,
  who: Enroller,
  issuer: string,
): Promise<{ secret: string; uri: string; qr: string }> {
  if (!deps.key)
    throw new AppError(
      501,
      'encryption_disabled',
      'O app autenticador precisa da chave de criptografia do servidor',
    );
  const { user } = await enrollerUser(deps, who);
  if ((await factors(deps.sql, user.id)).totp) throw badRequest('O app autenticador já está ligado');
  const secret = newTotpSecret();
  await ensureRow(deps.sql, user.id);
  await deps.sql`update user_mfa set totp_pending_sealed = ${sealSecret(deps.key, secret, totpAad(user.id))},
                 totp_pending_at = ${new Date(nowOf(deps))}, updated_at = now() where user_id = ${user.id}`;
  const uri = otpauthUri(issuer, user.email, secret);
  const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { secret, uri, qr };
}

export interface Enrolled {
  user: SessionUser;
  /** Shown once, with the first factor. */
  recoveryCodes?: string[];
}

export async function totpConfirm(
  deps: MfaDeps,
  who: Enroller,
  code: string,
  ip: string | null,
): Promise<Enrolled> {
  const { user, challenge } = await enrollerUser(deps, who);
  limited(user.id);
  const row = await mfaRow(deps.sql, user.id);
  const fresh =
    row?.totpPendingSealed &&
    row.totpPendingAt &&
    nowOf(deps) - row.totpPendingAt.getTime() < PENDING_TOTP_MINUTES * 60_000;
  if (!deps.key || !row || !fresh) throw badRequest('Comece de novo: o QR code expirou');
  const secret = openSecret(deps.key, row.totpPendingSealed!, totpAad(user.id));
  const step = verifyTotp(secret, code, 0, nowOf(deps));
  if (step === null) {
    if (challenge) return failedAttempt(deps.sql, challenge);
    throw badRequest('Código incorreto. Confira se o horário do celular está certo.');
  }
  await deps.sql`update user_mfa set totp_secret_sealed = totp_pending_sealed, totp_pending_sealed = null,
                 totp_pending_at = null, totp_enabled_at = now(), totp_last_step = ${step}, updated_at = now()
                 where user_id = ${user.id}`;
  const recoveryCodes = await firstRecoveryCodes(deps.sql, user.id);
  if (challenge) await consume(deps.sql, challenge);
  await changed(deps, user, 'mfa.totp_enabled', ip, 'O app autenticador foi ligado na sua conta');
  return { user, recoveryCodes };
}

export async function passkeyRegisterOptions(
  deps: MfaDeps,
  who: Enroller,
  rp: RelyingParty,
  ip: string | null,
) {
  const { user, challenge } = await enrollerUser(deps, who);
  const existing = await deps.sql<{ id: string; transports: string[] }[]>`
    select id, transports from webauthn_credentials where user_id = ${user.id} and rp_id = ${rp.id}`;
  if (existing.length >= 10) throw badRequest('Até 10 passkeys por conta');
  const options = await (deps.webauthn ?? realWebAuthn).generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  // Signed-in users get a ceremony of their own; enrolling users keep their sign-in challenge.
  const ceremony = challenge
    ? { token: (who as { token: string }).token, idHash: challenge.idHash }
    : await createChallenge(deps.sql, user.id, 'account', ip, nowOf(deps));
  await deps.sql`update auth_challenges set webauthn_challenge = ${options.challenge}
                 where id_hash = ${ceremony.idHash}`;
  return { token: ceremony.token, options };
}

type Registration = Extract<Awaited<ReturnType<typeof verifyRegistrationResponse>>, { verified: true }>;

export async function passkeyRegister(
  deps: MfaDeps,
  who: Enroller,
  token: string,
  response: RegistrationResponseJSON,
  name: string,
  rp: RelyingParty,
  ip: string | null,
): Promise<Enrolled> {
  const { user } = await enrollerUser(deps, who);
  const c = await loadChallenge(deps.sql, token, ['account', 'enroll'], user.id, nowOf(deps));
  if (!c.webauthnChallenge) throw badRequest('Comece de novo');
  let info: Registration['registrationInfo'];
  try {
    const result = await (deps.webauthn ?? realWebAuthn).verifyRegistrationResponse({
      response,
      expectedChallenge: c.webauthnChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
    if (!result.verified) throw new Error('not verified');
    info = result.registrationInfo;
  } catch {
    return failedAttempt(deps.sql, c);
  }
  const cred = info.credential;
  try {
    await deps.sql`
      insert into webauthn_credentials (id, user_id, rp_id, public_key, counter, transports, device_type,
                                        backed_up, name)
      values (${cred.id}, ${user.id}, ${rp.id}, ${Buffer.from(cred.publicKey)}, ${cred.counter},
              ${(cred.transports ?? []) as string[]}, ${info.credentialDeviceType}, ${info.credentialBackedUp},
              ${name.trim().slice(0, 60) || 'Passkey'})`;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw badRequest('Esta passkey já está cadastrada');
    throw err;
  }
  const recoveryCodes = await firstRecoveryCodes(deps.sql, user.id);
  await consume(deps.sql, c);
  await changed(
    deps,
    user,
    'mfa.passkey_added',
    ip,
    `A passkey "${name.trim() || 'Passkey'}" foi adicionada à sua conta`,
  );
  return { user, recoveryCodes };
}

export async function emailStart(deps: MfaDeps, who: Enroller, product: string, ip: string | null) {
  const { user, challenge } = await enrollerUser(deps, who);
  if ((await factors(deps.sql, user.id)).email) throw badRequest('O código por e-mail já está ligado');
  const token = challenge
    ? (who as { token: string }).token
    : (await createChallenge(deps.sql, user.id, 'account', ip, nowOf(deps))).token;
  await sendCode(
    deps,
    challenge ?? (await loadChallenge(deps.sql, token, ['account'], undefined, nowOf(deps))),
    user,
    product,
  );
  return { token, email: maskEmail(user.email) };
}

export async function emailConfirm(
  deps: MfaDeps,
  who: Enroller,
  token: string,
  code: string,
  ip: string | null,
): Promise<Enrolled> {
  const { user } = await enrollerUser(deps, who);
  limited(user.id);
  const c = await loadChallenge(deps.sql, token, ['account', 'enroll'], user.id, nowOf(deps));
  if (!matchEmailCode(c.idHash, code, c.emailCodeHash)) return failedAttempt(deps.sql, c);
  await ensureRow(deps.sql, user.id);
  await deps.sql`update user_mfa set email_enabled_at = now(), updated_at = now() where user_id = ${user.id}`;
  const recoveryCodes = await firstRecoveryCodes(deps.sql, user.id);
  await consume(deps.sql, c);
  await changed(deps, user, 'mfa.email_enabled', ip, 'O código por e-mail foi ligado na sua conta');
  return { user, recoveryCodes };
}

// --- Managing factors (signed in) -------------------------------------------------------

async function reauth(sql: Sql, user: SessionUser, password: string) {
  const [row] = await sql<{ hash: string }[]>`select password_hash as hash from users where id = ${user.id}`;
  if (!row || !(await verifyPassword(password, row.hash))) throw forbidden('Senha incorreta');
}

async function requireMfaOf(sql: Sql, tenantId: string): Promise<boolean> {
  const [row] = await sql<
    { requireMfa: boolean }[]
  >`select require_mfa as "requireMfa" from tenants where id = ${tenantId}`;
  return Boolean(row?.requireMfa);
}

/** Refuses to remove the last factor when the organization requires one. */
async function keepOne(sql: Sql, user: SessionUser, after: (f: Factors) => Factors) {
  const left = after(await factors(sql, user.id));
  if (!hasFactor(left) && (await requireMfaOf(sql, user.tenantId)))
    throw badRequest(
      'Sua organização exige a verificação em duas etapas: ligue outro método antes de tirar este',
    );
  return left;
}

/** Without any factor left, recovery codes mean nothing and are removed. */
async function cleanupIfNone(sql: Sql, userId: string, left: Factors) {
  if (!hasFactor(left))
    await sql`update user_mfa set recovery_hashes = '{}', recovery_created_at = null where user_id = ${userId}`;
}

export async function totpDisable(deps: MfaDeps, user: SessionUser, password: string, ip: string | null) {
  await reauth(deps.sql, user, password);
  const left = await keepOne(deps.sql, user, (f) => ({ ...f, totp: false }));
  await deps.sql`update user_mfa set totp_secret_sealed = null, totp_enabled_at = null, totp_last_step = 0,
                 updated_at = now() where user_id = ${user.id}`;
  await cleanupIfNone(deps.sql, user.id, left);
  await changed(deps, user, 'mfa.totp_disabled', ip, 'O app autenticador foi desligado da sua conta');
}

export async function emailDisable(deps: MfaDeps, user: SessionUser, password: string, ip: string | null) {
  await reauth(deps.sql, user, password);
  const left = await keepOne(deps.sql, user, (f) => ({ ...f, email: false }));
  await deps.sql`update user_mfa set email_enabled_at = null, updated_at = now() where user_id = ${user.id}`;
  await cleanupIfNone(deps.sql, user.id, left);
  await changed(deps, user, 'mfa.email_disabled', ip, 'O código por e-mail foi desligado da sua conta');
}

export async function passkeyRename(deps: MfaDeps, user: SessionUser, id: string, name: string) {
  const done = await deps.sql`update webauthn_credentials set name = ${name.trim().slice(0, 60)}
                              where id = ${id} and user_id = ${user.id}`;
  if (done.count === 0) throw notFound('Passkey não encontrada');
}

export async function passkeyRemove(
  deps: MfaDeps,
  user: SessionUser,
  id: string,
  password: string,
  ip: string | null,
) {
  await reauth(deps.sql, user, password);
  const [cred] = await deps.sql<{ name: string }[]>`
    select name from webauthn_credentials where id = ${id} and user_id = ${user.id}`;
  if (!cred) throw notFound('Passkey não encontrada');
  const left = await keepOne(deps.sql, user, (f) => ({ ...f, passkeysAnywhere: f.passkeysAnywhere - 1 }));
  await deps.sql`delete from webauthn_credentials where id = ${id} and user_id = ${user.id}`;
  await cleanupIfNone(deps.sql, user.id, left);
  await changed(deps, user, 'mfa.passkey_removed', ip, `A passkey "${cred.name}" foi removida da sua conta`);
}

export async function regenerateRecovery(
  deps: MfaDeps,
  user: SessionUser,
  password: string,
  ip: string | null,
) {
  await reauth(deps.sql, user, password);
  if (!hasFactor(await factors(deps.sql, user.id)))
    throw badRequest('Ligue um método de verificação primeiro');
  const codes = await issueRecoveryCodes(deps.sql, user.id);
  await changed(
    deps,
    user,
    'mfa.recovery_regenerated',
    ip,
    'Códigos de recuperação novos foram gerados (os antigos não valem mais)',
  );
  return codes;
}

export interface SecurityOverview {
  requireMfa: boolean;
  encryption: boolean;
  emailAvailable: boolean;
  totp: { enabled: boolean };
  email: { enabled: boolean };
  passkeys: {
    id: string;
    name: string;
    here: boolean;
    deviceType: string;
    backedUp: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
  }[];
  recovery: { left: number; createdAt: Date | null };
}

export async function securityOverview(
  deps: MfaDeps,
  user: SessionUser,
  rp: RelyingParty,
): Promise<SecurityOverview> {
  const row = await mfaRow(deps.sql, user.id);
  const passkeys = await deps.sql<SecurityOverview['passkeys']>`
    select id, name, rp_id = ${rp.id} as here, device_type as "deviceType", backed_up as "backedUp",
           created_at as "createdAt", last_used_at as "lastUsedAt"
    from webauthn_credentials where user_id = ${user.id} order by created_at`;
  return {
    requireMfa: await requireMfaOf(deps.sql, user.tenantId),
    encryption: Boolean(deps.key),
    emailAvailable: Boolean(await deps.mailerFor(user.tenantId).catch(() => null)),
    totp: { enabled: Boolean(row?.totpEnabledAt) },
    email: { enabled: Boolean(row?.emailEnabledAt) },
    passkeys,
    recovery: { left: row?.recoveryHashes.length ?? 0, createdAt: row?.recoveryCreatedAt ?? null },
  };
}

// --- Organization policy ----------------------------------------------------------------

export async function setRequireMfa(sql: Sql, actor: SessionUser, required: boolean, ip: string | null) {
  if (actor.role !== 'admin') throw forbidden();
  if (required && !hasFactor(await factors(sql, actor.id)))
    throw badRequest('Ligue a verificação em duas etapas na sua conta antes de exigir de todos');
  await sql`update tenants set require_mfa = ${required} where id = ${actor.tenantId}`;
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'tenant.require_mfa',
    meta: { required },
    ip,
  });
}

/** An admin clears someone's factors (lost phone): they sign in with the password again. */
export async function resetUserMfa(deps: MfaDeps, actor: SessionUser, userId: string, ip: string | null) {
  if (actor.role !== 'admin') throw forbidden();
  if (userId === actor.id) throw badRequest('Para a sua conta, use a página Minha conta');
  const [target] = await deps.sql<SessionUser[]>`
    select id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"
    from users where id = ${userId} and tenant_id = ${actor.tenantId}`;
  if (!target) throw notFound('Usuário não encontrado');
  await deps.sql.begin(async (tx) => {
    await tx`delete from webauthn_credentials where user_id = ${userId}`;
    await tx`delete from user_mfa where user_id = ${userId}`;
    await tx`delete from auth_challenges where user_id = ${userId}`;
    await tx`delete from sessions where user_id = ${userId}`;
  });
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'mfa.reset_by_admin',
    target: target.email,
    ip,
  });
  await notify(deps, target, 'A verificação em duas etapas da sua conta foi reiniciada', [
    `${actor.name} (administrador) tirou os métodos de verificação da sua conta e encerrou suas sessões.`,
    'No próximo acesso, entre com a sua senha e configure a verificação de novo.',
  ]);
}

// --- Telling the user -------------------------------------------------------------------

async function notify(deps: MfaDeps, user: SessionUser, subject: string, lines: string[]) {
  const mailer = await deps.mailerFor(user.tenantId).catch(() => null);
  if (!mailer) return;
  await mailer
    .send({ to: user.email, subject, text: `Olá, ${user.name}.\n\n${lines.join('\n\n')}\n` })
    .catch(() => undefined);
}

async function changed(deps: MfaDeps, user: SessionUser, action: string, ip: string | null, what: string) {
  await audit(deps.sql, { tenantId: user.tenantId, actorId: user.id, action, ip });
  await notify(deps, user, 'Segurança da sua conta', [
    `${what}.`,
    'Se não foi você, troque sua senha agora e fale com o administrador da organização.',
  ]);
}
