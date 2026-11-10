import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  type MailDeps,
  getPlatformMail,
  getTenantMail,
  platformMailer,
  savePlatformMail,
  saveTenantMail,
  tenantMailer,
  testPlatformMail,
  testTenantMail,
} from '@/server/mail/service';
import type { Transport } from '@/server/mail/smtp';
import { hashPassword } from '@/server/security/password';
import { platformSmtpInput, tenantSmtpInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';

/** Every connection and message, as an SMTP server would see them. */
const wire: {
  host: string;
  servername?: string;
  user?: string;
  pass?: string;
  mail: Record<string, unknown>;
}[] = [];
let failNext = false;
const transport: Transport = (options) => ({
  async sendMail(mail) {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('Invalid login'), { code: 'EAUTH' });
    }
    wire.push({
      host: options.host,
      servername: options.tls.servername,
      user: options.auth?.user,
      pass: options.auth?.pass,
      mail,
    });
  },
  close: () => undefined,
});
const resolve = async (host: string) => (host.endsWith('.interno') ? ['10.1.2.3'] : ['93.184.215.14']);
const deps = (over: Partial<MailDeps> = {}): MailDeps => ({
  sql: db(),
  key: READY_AGENT_KEY,
  resolve,
  transport,
  legacy: null,
  ...over,
});

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
  wire.length = 0;
  failNext = false;
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

async function member(tenantId: string) {
  const [m] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenantId}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return m;
}

const custom = (over: Record<string, unknown> = {}) =>
  tenantSmtpInput.parse({
    mode: 'custom',
    host: 'smtp.acme.com',
    port: 587,
    security: 'starttls',
    username: 'reunioes@acme.com',
    password: 'senha-de-app-123',
    fromEmail: 'reunioes@acme.com',
    fromName: '',
    ...over,
  });

describe('organization e-mail', () => {
  it('uses its own server under its own name, never returns the password and keeps it when left out', async () => {
    const { tenant, admin } = await org('acme');
    expect(await getTenantMail(deps(), admin)).toMatchObject({
      encryption: true,
      mode: 'platform',
      custom: null,
      platform: { available: false, from: null },
    });
    expect(await tenantMailer(deps(), tenant.id)).toBeNull();

    const saved = await saveTenantMail(deps(), admin, custom(), '1.2.3.4');
    expect(saved.mode).toBe('custom');
    expect(saved.custom).toMatchObject({ host: 'smtp.acme.com', hasPassword: true, lastTestOk: null });
    expect(JSON.stringify(saved)).not.toContain('senha-de-app-123');
    const [row] = await sql<{ sealed: string }[]>`select password_sealed as sealed from tenant_smtp`;
    expect(row.sealed.startsWith('enc:v1:')).toBe(true);

    const mailer = await tenantMailer(deps(), tenant.id);
    expect(mailer?.from).toBe('"Org acme" <reunioes@acme.com>');
    await mailer!.send({ to: 'ana@cliente.com', subject: 'Convite', text: 'oi' });
    expect(wire[0]).toMatchObject({
      host: '93.184.215.14',
      servername: 'smtp.acme.com',
      user: 'reunioes@acme.com',
      pass: 'senha-de-app-123',
    });

    // Saving again without a password keeps it; changing the server demands it again.
    await saveTenantMail(deps(), admin, custom({ password: undefined, fromName: 'Acme Reuniões' }), null);
    expect((await tenantMailer(deps(), tenant.id))?.from).toBe('"Acme Reuniões" <reunioes@acme.com>');
    await expectAppError(
      saveTenantMail(deps(), admin, custom({ host: 'smtp.outro.com', password: undefined }), null),
      400,
      /senha de novo/,
    );

    const ok = await testTenantMail(deps(), admin);
    expect(ok).toEqual({ ok: true, to: 'admin@acme.test' });
    expect(wire.at(-1)?.mail.to).toBe('admin@acme.test');
    failNext = true;
    expect(await testTenantMail(deps(), admin)).toEqual({
      ok: false,
      error: 'O servidor recusou o usuário ou a senha',
      to: 'admin@acme.test',
    });
    expect((await getTenantMail(deps(), admin)).custom).toMatchObject({
      lastTestOk: false,
      lastTestError: 'O servidor recusou o usuário ou a senha',
    });

    await saveTenantMail(deps(), admin, tenantSmtpInput.parse({ mode: 'off' }), null);
    expect(await tenantMailer(deps(), tenant.id)).toBeNull();
    const [log] = await sql<{ action: string; meta: { mode: string } }[]>`
      select action, meta from audit_log where action = 'mail.settings_changed' order by id desc limit 1`;
    expect(log.meta.mode).toBe('off');
  });

  it('refuses internal servers, odd ports, members, missing encryption and test spam', async () => {
    const { tenant, admin } = await org('acme');
    await expectAppError(
      saveTenantMail(deps(), admin, custom({ host: 'smtp.interno' }), null),
      400,
      /pública/,
    );
    await expectAppError(saveTenantMail(deps(), admin, custom({ port: 6379 }), null), 400, /porta SMTP/);
    await expectAppError(saveTenantMail(deps({ key: null }), admin, custom(), null), 501);
    const bia = await member(tenant.id);
    await expectAppError(getTenantMail(deps(), bia), 403);
    await expectAppError(saveTenantMail(deps(), bia, tenantSmtpInput.parse({ mode: 'off' }), null), 403);
    await expectAppError(testTenantMail(deps(), admin), 400, /Nenhum servidor/);

    await saveTenantMail(deps(), admin, custom(), null);
    for (let i = 0; i < 4; i++) await testTenantMail(deps(), admin);
    await expectAppError(testTenantMail(deps(), admin), 429);

    // A sealed password copied to another organization does not open.
    const rival = await org('rival');
    await saveTenantMail(
      deps(),
      rival.admin,
      custom({ host: 'smtp.rival.com', password: 'outra-senha-456' }),
      null,
    );
    await sql`update tenant_smtp set password_sealed = (select password_sealed from tenant_smtp where tenant_id = ${tenant.id})
              where tenant_id = ${rival.tenant.id}`;
    await expect(tenantMailer(deps(), rival.tenant.id)).rejects.toThrow();
  });
});

describe('platform e-mail', () => {
  it('is set by the super admin, may live on the private network, and is offered to organizations', async () => {
    const { tenant, admin } = await org('acme');
    await expectAppError(getPlatformMail(deps(), admin), 403);
    const root = { ...admin, isSuperadmin: true };
    const legacyDeps = deps({ legacy: { url: 'smtp://user:pass@mail.local:25', from: 'meet@impa.local' } });
    expect(await getPlatformMail(legacyDeps, root)).toMatchObject({ server: null, legacy: true });
    expect((await getTenantMail(legacyDeps, admin)).platform).toEqual({
      available: true,
      from: 'meet@impa.local',
    });
    expect((await platformMailer(legacyDeps))?.from).toBe('meet@impa.local');

    const input = platformSmtpInput.parse({
      host: 'postfix.interno',
      port: 25,
      security: 'none',
      fromEmail: 'nao-responda@impa365.com',
      fromName: 'Impa 365',
      replyTo: 'suporte@impa365.com',
      password: 'relay-pass-789',
      username: 'relay',
    });
    const view = await savePlatformMail(deps(), root, input, null);
    expect(view).toMatchObject({ legacy: false, server: { host: 'postfix.interno', offerToTenants: true } });
    expect(JSON.stringify(view)).not.toContain('relay-pass-789');

    // Organizations on "platform" send through it under their own name.
    const mailer = await tenantMailer(deps(), tenant.id);
    expect(mailer?.from).toBe('"Org acme" <nao-responda@impa365.com>');
    await mailer!.send({ to: 'x@y.com', subject: 's', text: 't' });
    expect(wire.at(-1)).toMatchObject({ host: '10.1.2.3', mail: { replyTo: 'suporte@impa365.com' } });
    expect(await testPlatformMail(deps(), root)).toMatchObject({ ok: true });
    expect((await getPlatformMail(deps(), root)).server?.lastTestOk).toBe(true);

    await savePlatformMail(deps(), root, { ...input, password: undefined, offerToTenants: false }, null);
    expect(await tenantMailer(deps(), tenant.id)).toBeNull();
    expect((await getTenantMail(deps(), admin)).platform).toEqual({ available: false, from: null });
    expect((await platformMailer(deps()))?.from).toBe('"Impa 365" <nao-responda@impa365.com>');
  });
});
