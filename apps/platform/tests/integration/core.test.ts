import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { login, signup } from '@/server/auth/service';
import {
  type SessionUser,
  createSession,
  deleteSession,
  findSessionUser,
  purgeExpiredSessions,
  SESSION_TTL_MS,
} from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  authorizeJoin,
  canManageAllRooms,
  createRoom,
  deleteRoom,
  findRoom,
  listRooms,
} from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import {
  DEFAULT_BRANDING,
  type Tenant,
  findBranding,
  findTenantByDomain,
  findTenantBySlug,
} from '@/server/tenants/repo';
import { createRoomInput } from '@/server/validation';
import { migrate } from '../../scripts/migrate.mjs';
import { type TestSql, freshDatabase } from './db';

let sql: TestSql;
const db = () => sql as unknown as Sql;

const PASSWORD = 'senha-muito-segura';
const R = (input: Record<string, unknown>) => createRoomInput.parse(input);

async function newOrg(slug: string) {
  return signup(
    db(),
    { organization: `Org ${slug}`, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    '203.0.113.1',
    'enterprise',
  );
}

async function addUser(tenant: Tenant, email: string, role: SessionUser['role'], status = 'active') {
  const [user] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role, status)
    values (${tenant.id}, ${email}, ${email.split('@')[0]}, ${await hashPassword(PASSWORD)}, ${role}, ${status})
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return user;
}

async function expectAppError(promise: Promise<unknown>, status: number, code?: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (code) expect((err as AppError).code).toBe(code);
}

beforeAll(async () => {
  sql = await freshDatabase();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
});

describe('migrations', () => {
  it('wait for the database, then fail clearly when it never comes up', async () => {
    const messages: string[] = [];
    await expect(
      migrate('postgres://nobody:x@127.0.0.1:1/none', (m) => messages.push(m), { attempts: 3, delayMs: 10 }),
    ).rejects.toThrow();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/database not ready .* retry 1\/2/);
  });

  it('are idempotent', async () => {
    await migrate(process.env.TEST_DATABASE_URL!, () => {});
    const rows = await sql`select name from schema_migrations`;
    const files = readdirSync(path.join(__dirname, '../../migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files[0]).toBe('0001_init.sql');
    expect(rows.map((r) => r.name)).toEqual(files);
  });
});

describe('signup', () => {
  it('creates tenant, branding and an admin, and audits it', async () => {
    const { tenant, user } = await newOrg('acme');
    expect(tenant).toMatchObject({ slug: 'acme', name: 'Org acme', status: 'active', plan: 'enterprise' });
    expect(user).toMatchObject({ role: 'admin', email: 'admin@acme.test', isSuperadmin: false });
    expect(await findBranding(db(), tenant.id)).toMatchObject({ productName: 'Org acme' });
    const [entry] = await sql`select action, target, ip from audit_log`;
    expect(entry).toMatchObject({ action: 'tenant.created', target: 'acme', ip: '203.0.113.1' });
    const [stored] = await sql`select password_hash from users where id = ${user.id}`;
    expect(stored.password_hash).not.toContain(PASSWORD);
  });

  it('refuses a taken slug without leaving partial data', async () => {
    await newOrg('acme');
    await expectAppError(newOrg('acme'), 409, 'conflict');
    expect((await sql`select count(*)::int as n from users`)[0].n).toBe(1);
  });
});

describe('tenant lookup', () => {
  it('finds by slug and by verified domain only', async () => {
    const { tenant } = await newOrg('acme');
    expect((await findTenantBySlug(db(), 'acme'))?.id).toBe(tenant.id);
    expect(await findTenantBySlug(db(), 'nope')).toBeNull();

    await sql`insert into tenant_domains (hostname, tenant_id, verification_token)
              values ('meet.acme.com', ${tenant.id}, 'tok')`;
    expect(await findTenantByDomain(db(), 'meet.acme.com')).toBeNull();
    await sql`update tenant_domains set verified_at = now()`;
    expect((await findTenantByDomain(db(), 'meet.acme.com'))?.slug).toBe('acme');
  });

  it('falls back to default branding', async () => {
    expect(await findBranding(db(), '00000000-0000-4000-8000-000000000000')).toEqual(DEFAULT_BRANDING);
  });
});

describe('login and sessions', () => {
  it('logs in, creates a session scoped to the tenant, and logs out', async () => {
    const { tenant } = await newOrg('acme');
    const { tenant: other } = await newOrg('other');
    const user = await login(db(), tenant, { email: 'admin@acme.test', password: PASSWORD }, null);
    const session = await createSession(db(), user.id, { ip: '198.51.100.2', userAgent: 'x'.repeat(500) });

    expect(await findSessionUser(db(), session.token, tenant.id)).toMatchObject({
      id: user.id,
      role: 'admin',
    });
    expect(await findSessionUser(db(), session.token, other.id)).toBeNull();
    expect(await findSessionUser(db(), 'forged-token', tenant.id)).toBeNull();
    expect(await findSessionUser(db(), undefined, tenant.id)).toBeNull();
    expect(await findSessionUser(db(), 'x'.repeat(101), tenant.id)).toBeNull();

    const [row] = await sql`select id_hash, user_agent from sessions`;
    expect(Buffer.from(row.id_hash).toString()).not.toContain(session.token);
    expect(row.user_agent).toHaveLength(300);

    await deleteSession(db(), session.token);
    await deleteSession(db(), undefined);
    expect(await findSessionUser(db(), session.token, tenant.id)).toBeNull();
  });

  it('refreshes last_seen only after the touch interval', async () => {
    const { tenant, user } = await newOrg('acme');
    const session = await createSession(db(), user.id, {});
    await sql`update sessions set last_seen_at = now() - interval '1 hour'`;
    await findSessionUser(db(), session.token, tenant.id);
    const [row] = await sql`select last_seen_at > now() - interval '1 minute' as fresh from sessions`;
    expect(row.fresh).toBe(true);
  });

  it('rejects expired sessions and purges them', async () => {
    const { tenant, user } = await newOrg('acme');
    const past = new Date(Date.now() - SESSION_TTL_MS - 1000);
    const session = await createSession(db(), user.id, {}, past);
    expect(await findSessionUser(db(), session.token, tenant.id)).toBeNull();
    expect(await purgeExpiredSessions(db())).toBe(1);
  });

  it('rejects wrong passwords, unknown and disabled users the same way, and audits failures', async () => {
    const { tenant } = await newOrg('acme');
    await addUser(tenant, 'off@acme.test', 'member', 'disabled');
    for (const email of ['admin@acme.test', 'ghost@acme.test', 'off@acme.test']) {
      const password = email.startsWith('admin') ? 'wrong-password' : PASSWORD;
      await expectAppError(login(db(), tenant, { email, password }, null), 401, 'unauthorized');
    }
    const failures = await sql`select count(*)::int as n from audit_log where action = 'auth.login_failed'`;
    expect(failures[0].n).toBe(3);
  });

  it('ignores sessions of disabled users', async () => {
    const { tenant } = await newOrg('acme');
    const member = await addUser(tenant, 'bia@acme.test', 'member');
    const session = await createSession(db(), member.id, {});
    await sql`update users set status = 'disabled' where id = ${member.id}`;
    expect(await findSessionUser(db(), session.token, tenant.id)).toBeNull();
  });
});

describe('rooms', () => {
  let tenant: Tenant;
  let admin: SessionUser;
  let manager: SessionUser;
  let member: SessionUser;
  let otherMember: SessionUser;

  beforeEach(async () => {
    ({ tenant, user: admin } = await newOrg('acme'));
    manager = await addUser(tenant, 'gestor@acme.test', 'manager');
    member = await addUser(tenant, 'bia@acme.test', 'member');
    otherMember = await addUser(tenant, 'caio@acme.test', 'member');
  });

  it('derives a slug from the name and de-duplicates it', async () => {
    const a = await createRoom(
      db(),
      member,
      R({ name: 'Reunião de Vendas', allowGuests: true, agentEnabled: false }),
      null,
    );
    const b = await createRoom(
      db(),
      member,
      R({ name: 'Reunião de Vendas', allowGuests: true, agentEnabled: false }),
      null,
    );
    expect(a.slug).toBe('reuniao-de-vendas');
    expect(b.slug).toMatch(/^reuniao-de-vendas-[0-9a-f]{6}$/);
    expect(a).toMatchObject({ hasPassword: false, allowGuests: true, ownerId: member.id });
  });

  it('uses a fallback slug for names without letters', async () => {
    const room = await createRoom(
      db(),
      member,
      R({ name: '!!!', allowGuests: true, agentEnabled: false }),
      null,
    );
    expect(room.slug).toBe('sala');
  });

  it('refuses an explicit slug that is taken', async () => {
    await createRoom(
      db(),
      member,
      R({ name: 'A', slug: 'daily', allowGuests: true, agentEnabled: false }),
      null,
    );
    await expectAppError(
      createRoom(
        db(),
        otherMember,
        R({ name: 'B', slug: 'daily', allowGuests: true, agentEnabled: false }),
        null,
      ),
      409,
    );
  });

  it('isolates rooms between tenants', async () => {
    const { user: foreignAdmin, tenant: foreign } = await newOrg('other');
    await createRoom(
      db(),
      member,
      R({ name: 'Daily', slug: 'daily', allowGuests: true, agentEnabled: false }),
      null,
    );
    await createRoom(
      db(),
      foreignAdmin,
      R({ name: 'Daily', slug: 'daily', allowGuests: true, agentEnabled: false }),
      null,
    );
    expect((await findRoom(db(), foreign.id, 'daily'))?.ownerId).toBe(foreignAdmin.id);
    expect(await listRooms(db(), foreignAdmin)).toHaveLength(1);
    await expectAppError(deleteRoom(db(), foreignAdmin, 'missing', null), 404);
  });

  it('lists own rooms for members and all rooms for admins and managers', async () => {
    await createRoom(db(), member, R({ name: 'Bia', allowGuests: true, agentEnabled: false }), null);
    await createRoom(db(), otherMember, R({ name: 'Caio', allowGuests: true, agentEnabled: false }), null);
    expect((await listRooms(db(), member)).map((r) => r.name)).toEqual(['Bia']);
    expect(await listRooms(db(), admin)).toHaveLength(2);
    expect(await listRooms(db(), manager)).toHaveLength(2);
    expect(canManageAllRooms(member)).toBe(false);
  });

  it('lets owners, admins and managers delete, and nobody else', async () => {
    const room = await createRoom(
      db(),
      member,
      R({ name: 'Bia', allowGuests: true, agentEnabled: false }),
      null,
    );
    await expectAppError(deleteRoom(db(), otherMember, room.slug, null), 403);
    await deleteRoom(db(), manager, room.slug, '203.0.113.5');
    expect(await findRoom(db(), tenant.id, room.slug)).toBeNull();
    const [entry] = await sql`select actor_id, action from audit_log where action = 'room.deleted'`;
    expect(entry.actor_id).toBe(manager.id);
  });

  describe('join authorization', () => {
    it('makes owners and admins moderators and lets them skip the password', async () => {
      const room = await createRoom(
        db(),
        member,
        R({ name: 'Privada', password: 'abcd1234', allowGuests: true, agentEnabled: true }),
        null,
      );
      expect(room.hasPassword).toBe(true);
      expect(await authorizeJoin(db(), room, member, undefined)).toMatchObject({ role: 'moderator' });
      expect((await authorizeJoin(db(), room, admin, undefined)).identity).toMatch(
        new RegExp(`^u-${admin.id}-[0-9a-f]{6}$`),
      );
    });

    it('requires the password from other members and guests', async () => {
      const room = await createRoom(
        db(),
        member,
        R({ name: 'Privada', password: 'abcd1234', allowGuests: true, agentEnabled: false }),
        null,
      );
      await expectAppError(authorizeJoin(db(), room, otherMember, undefined), 401, 'room_password');
      await expectAppError(authorizeJoin(db(), room, null, 'wrong'), 401, 'room_password');
      expect(await authorizeJoin(db(), room, otherMember, 'abcd1234')).toMatchObject({ role: 'participant' });
      const guest = await authorizeJoin(db(), room, null, 'abcd1234');
      expect(guest.role).toBe('guest');
      expect(guest.identity).toMatch(/^g-[0-9a-f]{12}$/);
    });

    it('keeps guests out of member-only rooms', async () => {
      const room = await createRoom(
        db(),
        member,
        R({ name: 'Interna', allowGuests: false, agentEnabled: false }),
        null,
      );
      await expectAppError(authorizeJoin(db(), room, null, undefined), 401, 'unauthorized');
      expect(await authorizeJoin(db(), room, otherMember, undefined)).toMatchObject({ role: 'participant' });
    });

    it('gives every join a distinct identity', async () => {
      const room = await createRoom(
        db(),
        member,
        R({ name: 'Aberta', allowGuests: true, agentEnabled: false }),
        null,
      );
      const a = await authorizeJoin(db(), room, member, undefined);
      const b = await authorizeJoin(db(), room, member, undefined);
      expect(a.identity).not.toBe(b.identity);
    });
  });
});

describe('database constraints', () => {
  it.each([
    (sql) => sql`insert into tenants (slug, name) values ('Bad Slug', 'x')`,
    (sql) => sql`insert into tenants (slug, name) values ('ok', '')`,
    (sql) => sql`insert into tenant_branding (tenant_id, product_name, primary_color)
               select id, 'x', 'red' from tenants limit 1`,
    (sql) => sql`insert into tenant_branding (tenant_id, product_name, logo_url)
               select id, 'x', 'http://insecure.test/logo.png' from tenants limit 1`,
  ] as ((s: TestSql) => Promise<unknown>)[])('rejects invalid rows (%#)', async (insert) => {
    await newOrg('acme');
    await sql`delete from tenant_branding`;
    await expect(insert(sql)).rejects.toThrow();
  });
});
