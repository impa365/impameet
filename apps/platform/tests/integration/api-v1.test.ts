import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  actorForOrg,
  createApiKey,
  findApiKeyOwner,
  listApiKeys,
  listMembershipsByEmail,
  revokeApiKey,
} from '@/server/api-keys/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import { createRoom, listRooms } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import type { Tenant } from '@/server/tenants/repo';
import { createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';

async function newOrg(slug: string) {
  return signup(
    db(),
    {
      organization: `Org ${slug}`,
      slug,
      name: 'Admin',
      email: `admin@${slug}.test`,
      password: PASSWORD,
    },
    '203.0.113.1',
    'enterprise',
  );
}

async function addUser(tenant: Tenant, email: string, role: string) {
  const [user] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role, status)
    values (${tenant.id}, ${email}, ${email.split('@')[0]}, ${await hashPassword(PASSWORD)}, ${role}, 'active')
    returning id, tenant_id as "tenantId", email, name, role, false as "isSuperadmin"`;
  return user;
}

beforeAll(async () => {
  sql = await freshDatabase();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql`truncate tenants, audit_log, user_api_key_audit restart identity cascade`;
});

describe('user API keys across orgs', () => {
  it('lets one key act in every org where the email is a member', async () => {
    const a = await newOrg('alpha');
    const b = await newOrg('beta');
    const shared = 'pessoa@example.com';
    const userA = await addUser(a.tenant, shared, 'admin');
    await addUser(b.tenant, shared, 'member');

    const created = await createApiKey(db(), userA, { name: 'CRM' });
    expect(created.token.startsWith('impa_')).toBe(true);
    expect(created.prefix).toBe(created.token.slice(0, 13));

    const owner = await findApiKeyOwner(db(), created.token);
    expect(owner?.email).toBe(shared);

    const orgs = await listMembershipsByEmail(db(), shared);
    expect(orgs.map((o) => o.slug).sort()).toEqual(['alpha', 'beta']);

    const asAdmin = await actorForOrg(db(), owner!, a.tenant.id);
    expect(asAdmin.role).toBe('admin');
    expect(asAdmin.permissions?.includes('agents.manage')).toBe(true);

    const asMember = await actorForOrg(db(), owner!, b.tenant.id);
    expect(asMember.role).toBe('member');
    expect(asMember.permissions ?? []).toEqual([]);

    await createRoom(db(), asAdmin, createRoomInput.parse({ name: 'Sala API' }), null);
    expect(await listRooms(db(), asAdmin)).toHaveLength(1);
    expect(await listRooms(db(), asMember)).toHaveLength(0);

    // Same person in another org still sees and can revoke the key (email-scoped).
    expect(await listApiKeys(db(), shared)).toHaveLength(1);
    await revokeApiKey(db(), shared, created.id);
    expect(await findApiKeyOwner(db(), created.token)).toBeNull();
  });

  it('intersects key scopes with the org role', async () => {
    const a = await newOrg('gamma');
    const user = await addUser(a.tenant, 'scoped@example.com', 'admin');
    const created = await createApiKey(db(), user, {
      name: 'só salas',
      scopes: ['rooms.manage_all'],
    });
    const owner = (await findApiKeyOwner(db(), created.token))!;
    const actor = await actorForOrg(db(), owner, a.tenant.id);
    expect(actor.permissions).toEqual(['rooms.manage_all']);
  });

  it('rejects acting in an org where the email is not a member', async () => {
    const a = await newOrg('delta');
    const b = await newOrg('echo');
    const user = await addUser(a.tenant, 'solo@example.com', 'admin');
    const created = await createApiKey(db(), user, { name: 'solo' });
    const owner = (await findApiKeyOwner(db(), created.token))!;
    await expect(actorForOrg(db(), owner, b.tenant.id)).rejects.toBeInstanceOf(AppError);
  });
});
