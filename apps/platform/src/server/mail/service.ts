import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, badRequest, forbidden, tooManyRequests } from '../errors';
import { RateLimiter } from '../security/rate-limit';
import type { Resolver } from '../security/public-url';
import { openSecret, sealSecret } from '../security/secrets';
import type { platformSmtpInput, tenantSmtpInput } from '../validation';
import {
  type Mailer,
  SMTP_PORTS,
  type SmtpSecurity,
  type SmtpSettings,
  type Transport,
  smtpAddress,
  smtpError,
  smtpMailer,
  urlMailer,
} from './smtp';

export interface MailDeps {
  sql: Sql;
  /** Null without an encryption key: then passwords cannot be stored. */
  key: Buffer | null;
  resolve?: Resolver;
  transport?: Transport;
  /** SMTP_URL + MAIL_FROM from the environment, the platform's server before it had a page. */
  legacy?: { url: string; from: string } | null;
}

export type TenantMode = 'platform' | 'custom' | 'off';

interface Row {
  host: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  username: string;
  passwordSealed: string | null;
  fromEmail: string | null;
  fromName: string;
  replyTo: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
}

/** What the panel shows of a server: never the password, only whether there is one. */
export interface SmtpView {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  updatedAt: Date;
}

export interface TenantMailView {
  encryption: boolean;
  mode: TenantMode;
  custom: SmtpView | null;
  /** The platform's server, when the super admin offers it to organizations. */
  platform: { available: boolean; from: string | null };
}

export interface PlatformMailView {
  encryption: boolean;
  server: (SmtpView & { offerToTenants: boolean }) | null;
  /** The environment's SMTP_URL is in use while no server is saved here. */
  legacy: boolean;
}

const COLUMNS = (sql: Sql) => sql`
  host, port, security, username, password_sealed as "passwordSealed", from_email as "fromEmail",
  from_name as "fromName", reply_to as "replyTo", last_test_at as "lastTestAt",
  last_test_ok as "lastTestOk", last_test_error as "lastTestError", updated_at as "updatedAt"`;

const tenantAad = (tenantId: string) => `smtp:tenant:${tenantId}`;
const PLATFORM_AAD = 'smtp:platform';
const tests = new RateLimiter(5, 10 * 60_000);

function view(row: Row): SmtpView | null {
  if (!row.host || !row.port || !row.security || !row.fromEmail) return null;
  return {
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    hasPassword: Boolean(row.passwordSealed),
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
    lastTestAt: row.lastTestAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    updatedAt: row.updatedAt,
  };
}

function settingsOf(row: Row, key: Buffer, aad: string): SmtpSettings {
  return {
    host: row.host!,
    port: row.port!,
    security: row.security!,
    username: row.username,
    password: row.passwordSealed ? openSecret(key, row.passwordSealed, aad) : '',
    fromEmail: row.fromEmail!,
    fromName: row.fromName,
    replyTo: row.replyTo,
  };
}

function needKey(deps: MailDeps): Buffer {
  if (!deps.key)
    throw new AppError(
      501,
      'encryption_disabled',
      'Configure a chave de criptografia do servidor para salvar o SMTP',
    );
  return deps.key;
}

function assertAdmin(user: SessionUser) {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram o e-mail');
}

function assertSuperadmin(user: SessionUser) {
  if (!user.isSuperadmin) throw forbidden('Área exclusiva do super admin');
}

async function platformRow(sql: Sql) {
  const [row] = await sql<(Row & { offerToTenants: boolean })[]>`
    select ${COLUMNS(sql)}, offer_to_tenants as "offerToTenants" from platform_smtp where id`;
  return row ?? null;
}

async function tenantRow(sql: Sql, tenantId: string) {
  const [row] = await sql<(Row & { mode: TenantMode })[]>`
    select ${COLUMNS(sql)}, mode from tenant_smtp where tenant_id = ${tenantId}`;
  return row ?? null;
}

async function productName(sql: Sql, tenantId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`
    select coalesce(nullif(b.product_name, ''), t.name) as name
    from tenants t left join tenant_branding b on b.tenant_id = t.id where t.id = ${tenantId}`;
  return row?.name ?? '';
}

// --- The mailer an organization's messages go out through -------------------------------

/** The platform's server as such (its own name), or null when there is none. */
export async function platformMailer(deps: MailDeps): Promise<Mailer | null> {
  const row = await platformRow(deps.sql);
  if (row && deps.key) {
    const s = settingsOf(row, deps.key, PLATFORM_AAD);
    return smtpMailer(
      s,
      { name: s.fromName, email: s.fromEmail, replyTo: s.replyTo },
      { resolve: deps.resolve, allowPrivate: true },
      deps.transport,
    );
  }
  return deps.legacy ? urlMailer(deps.legacy.url, deps.legacy.from) : null;
}

/**
 * How an organization sends: its own server, the platform's (under the organization's name),
 * or not at all. Null means there is no way to send e-mail right now.
 */
export async function tenantMailer(deps: MailDeps, tenantId: string): Promise<Mailer | null> {
  const row = await tenantRow(deps.sql, tenantId);
  const mode = row?.mode ?? 'platform';
  if (mode === 'off') return null;
  if (mode === 'custom' && row && deps.key && view(row)) {
    const s = settingsOf(row, deps.key, tenantAad(tenantId));
    return smtpMailer(
      s,
      { name: s.fromName || (await productName(deps.sql, tenantId)), email: s.fromEmail, replyTo: s.replyTo },
      { resolve: deps.resolve },
      deps.transport,
    );
  }
  if (mode !== 'platform') return null;
  const platform = await platformRow(deps.sql);
  if (platform) {
    if (!platform.offerToTenants || !deps.key) return null;
    const s = settingsOf(platform, deps.key, PLATFORM_AAD);
    return smtpMailer(
      s,
      { name: await productName(deps.sql, tenantId), email: s.fromEmail, replyTo: s.replyTo },
      { resolve: deps.resolve, allowPrivate: true },
      deps.transport,
    );
  }
  return deps.legacy ? urlMailer(deps.legacy.url, deps.legacy.from) : null;
}

// --- Organization settings --------------------------------------------------------------

export async function getTenantMail(deps: MailDeps, actor: SessionUser): Promise<TenantMailView> {
  assertAdmin(actor);
  const row = await tenantRow(deps.sql, actor.tenantId);
  const platform = await platformRow(deps.sql);
  const available = platform ? platform.offerToTenants : Boolean(deps.legacy);
  return {
    encryption: Boolean(deps.key),
    mode: row?.mode ?? 'platform',
    custom: row ? view(row) : null,
    platform: {
      available,
      from: available ? (platform?.fromEmail ?? deps.legacy?.from ?? null) : null,
    },
  };
}

type TenantInput = z.infer<typeof tenantSmtpInput>;
type ServerInput = Omit<Extract<TenantInput, { mode: 'custom' }>, 'mode'>;

async function sealedPassword(
  key: Buffer,
  input: ServerInput,
  current: Row | null,
  aad: string,
  hostChanged: boolean,
): Promise<string | null> {
  if (input.password !== undefined) return input.password ? sealSecret(key, input.password, aad) : null;
  if (hostChanged && current?.passwordSealed)
    throw badRequest('Ao trocar o servidor SMTP, informe a senha de novo');
  return current?.passwordSealed ?? null;
}

export async function saveTenantMail(
  deps: MailDeps,
  actor: SessionUser,
  input: TenantInput,
  ip: string | null,
): Promise<TenantMailView> {
  assertAdmin(actor);
  const { sql } = deps;
  if (input.mode !== 'custom') {
    await sql`
      insert into tenant_smtp (tenant_id, mode, updated_by) values (${actor.tenantId}, ${input.mode}, ${actor.id})
      on conflict (tenant_id) do update set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = now()`;
  } else {
    const key = needKey(deps);
    if (!(SMTP_PORTS as readonly number[]).includes(input.port))
      throw badRequest(`Use uma porta SMTP: ${SMTP_PORTS.join(', ')}`);
    await smtpAddress(input.host, { resolve: deps.resolve });
    const current = await tenantRow(sql, actor.tenantId);
    const password = await sealedPassword(
      key,
      input,
      current,
      tenantAad(actor.tenantId),
      Boolean(current?.host && current.host !== input.host),
    );
    await sql`
      insert into tenant_smtp (tenant_id, mode, host, port, security, username, password_sealed, from_email,
                               from_name, reply_to, last_test_at, last_test_ok, last_test_error, updated_by)
      values (${actor.tenantId}, 'custom', ${input.host}, ${input.port}, ${input.security}, ${input.username},
              ${password}, ${input.fromEmail}, ${input.fromName}, ${input.replyTo}, null, null, null, ${actor.id})
      on conflict (tenant_id) do update set
        mode = 'custom', host = excluded.host, port = excluded.port, security = excluded.security,
        username = excluded.username, password_sealed = excluded.password_sealed,
        from_email = excluded.from_email, from_name = excluded.from_name, reply_to = excluded.reply_to,
        last_test_at = null, last_test_ok = null, last_test_error = null,
        updated_by = excluded.updated_by, updated_at = now()`;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'mail.settings_changed',
    target: input.mode === 'custom' ? input.host : input.mode,
    meta: { mode: input.mode },
    ip,
  });
  return getTenantMail(deps, actor);
}

const testMail = (product: string) => ({
  subject: `Teste de e-mail — ${product}`,
  text:
    `Este é um e-mail de teste enviado pelo ${product}.\n\n` +
    'Se ele chegou, os convites de reunião, as atas e os códigos de acesso também vão chegar.',
});

async function runTest(
  sql: Sql,
  mailer: Mailer | null,
  actor: SessionUser,
  record: (ok: boolean, error: string | null) => Promise<unknown>,
): Promise<{ ok: boolean; error?: string; to: string }> {
  if (!tests.take(`smtp-test:${actor.id}`)) throw tooManyRequests();
  if (!mailer) throw badRequest('Nenhum servidor de e-mail configurado');
  const product = await productName(sql, actor.tenantId);
  try {
    await mailer.send({ to: actor.email, ...testMail(product) });
    await record(true, null);
    return { ok: true, to: actor.email };
  } catch (err) {
    const error = smtpError(err);
    await record(false, error);
    return { ok: false, error, to: actor.email };
  }
}

/** Sends a test message to the admin's own address (never to anyone else: no relaying). */
export async function testTenantMail(deps: MailDeps, actor: SessionUser) {
  assertAdmin(actor);
  const row = await tenantRow(deps.sql, actor.tenantId);
  return runTest(deps.sql, await tenantMailer(deps, actor.tenantId), actor, async (ok, error) => {
    if (row?.mode === 'custom')
      await deps.sql`update tenant_smtp set last_test_at = now(), last_test_ok = ${ok}, last_test_error = ${error}
                     where tenant_id = ${actor.tenantId}`;
  });
}

// --- The platform's server (super admin) ------------------------------------------------

export async function getPlatformMail(deps: MailDeps, actor: SessionUser): Promise<PlatformMailView> {
  assertSuperadmin(actor);
  const row = await platformRow(deps.sql);
  const server = row ? view(row) : null;
  return {
    encryption: Boolean(deps.key),
    server: server && row ? { ...server, offerToTenants: row.offerToTenants } : null,
    legacy: !row && Boolean(deps.legacy),
  };
}

export async function savePlatformMail(
  deps: MailDeps,
  actor: SessionUser,
  input: z.infer<typeof platformSmtpInput>,
  ip: string | null,
): Promise<PlatformMailView> {
  assertSuperadmin(actor);
  const key = needKey(deps);
  await smtpAddress(input.host, { resolve: deps.resolve, allowPrivate: true });
  const current = await platformRow(deps.sql);
  const password = await sealedPassword(
    key,
    input,
    current,
    PLATFORM_AAD,
    Boolean(current?.host && current.host !== input.host),
  );
  await deps.sql`
    insert into platform_smtp (id, host, port, security, username, password_sealed, from_email, from_name,
                               reply_to, offer_to_tenants, updated_by)
    values (true, ${input.host}, ${input.port}, ${input.security}, ${input.username}, ${password},
            ${input.fromEmail}, ${input.fromName}, ${input.replyTo}, ${input.offerToTenants}, ${actor.id})
    on conflict (id) do update set
      host = excluded.host, port = excluded.port, security = excluded.security, username = excluded.username,
      password_sealed = excluded.password_sealed, from_email = excluded.from_email,
      from_name = excluded.from_name, reply_to = excluded.reply_to,
      offer_to_tenants = excluded.offer_to_tenants, last_test_at = null, last_test_ok = null,
      last_test_error = null, updated_by = excluded.updated_by, updated_at = now()`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'mail.platform_changed',
    target: input.host,
    meta: { offerToTenants: input.offerToTenants },
    ip,
  });
  return getPlatformMail(deps, actor);
}

export async function testPlatformMail(deps: MailDeps, actor: SessionUser) {
  assertSuperadmin(actor);
  return runTest(deps.sql, await platformMailer(deps), actor, async (ok, error) => {
    await deps.sql`update platform_smtp set last_test_at = now(), last_test_ok = ${ok}, last_test_error = ${error}
                   where id`;
  });
}
