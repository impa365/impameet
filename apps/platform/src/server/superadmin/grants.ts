import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { audit } from '../audit';
import { assertSuperadmin } from './service';

export interface SuperadminRow {
  userId: string;
  email: string;
  name: string;
  tenantSlug: string;
  tenantName: string;
  grantedAt: Date;
  grantedByEmail: string | null;
}

export async function listSuperadmins(sql: Sql, actor: SessionUser | null): Promise<SuperadminRow[]> {
  assertSuperadmin(actor);
  return sql<SuperadminRow[]>`
    select sa.user_id as "userId", u.email, u.name, t.slug as "tenantSlug", t.name as "tenantName",
           sa.granted_at as "grantedAt", g.email as "grantedByEmail"
    from platform_superadmins sa
    join users u on u.id = sa.user_id
    join tenants t on t.id = u.tenant_id
    left join users g on g.id = sa.granted_by
    order by sa.granted_at`;
}

/**
 * Only an existing platform super admin may grant. The exclusive table is the source of truth;
 * users.is_superadmin is kept in sync by a DB trigger.
 */
export async function grantSuperadmin(
  sql: Sql,
  actor: SessionUser | null,
  userId: string,
  ip: string | null,
): Promise<void> {
  assertSuperadmin(actor);
  const [target] = await sql<{ id: string; email: string; tenantId: string }[]>`
    select id, email, tenant_id as "tenantId" from users where id = ${userId} and status = 'active'`;
  if (!target) throw notFound('Usuário não encontrado');
  await sql`
    insert into platform_superadmins (user_id, granted_by)
    values (${target.id}, ${actor.id})
    on conflict (user_id) do nothing`;
  await audit(sql, {
    tenantId: target.tenantId,
    actorId: actor.id,
    action: 'platform.superadmin.granted',
    target: target.email,
    ip,
  });
}

export async function revokeSuperadmin(
  sql: Sql,
  actor: SessionUser | null,
  userId: string,
  ip: string | null,
): Promise<void> {
  assertSuperadmin(actor);
  if (userId === actor.id) throw badRequest('Você não pode remover o próprio super admin');
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from platform_superadmins`;
  if (n <= 1) throw badRequest('A plataforma precisa de pelo menos um super admin');
  const [target] = await sql<{ email: string; tenantId: string }[]>`
    select u.email, u.tenant_id as "tenantId"
    from platform_superadmins sa join users u on u.id = sa.user_id
    where sa.user_id = ${userId}`;
  if (!target) throw notFound('Este usuário não é super admin');
  await sql`delete from platform_superadmins where user_id = ${userId}`;
  await audit(sql, {
    tenantId: target.tenantId,
    actorId: actor.id,
    action: 'platform.superadmin.revoked',
    target: target.email,
    ip,
  });
}

/** True when the exclusive table has this user (preferred over the denormalized flag alone). */
export async function isPlatformSuperadmin(sql: Sql, userId: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select true as ok from platform_superadmins where user_id = ${userId}`;
  return Boolean(row);
}

/**
 * After creating the first user of a brand-new install, grant platform super admin
 * only when the exclusive table is still empty.
 */
export async function maybeBootstrapSuperadmin(sql: Sql, userId: string): Promise<boolean> {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from platform_superadmins`;
  if (n > 0) return false;
  await sql`
    insert into platform_superadmins (user_id, granted_by)
    values (${userId}, null)
    on conflict (user_id) do nothing`;
  return true;
}

/** Search active users to grant (by email substring). */
export async function searchUsersForGrant(
  sql: Sql,
  actor: SessionUser | null,
  q: string,
): Promise<{ id: string; email: string; name: string; tenantSlug: string }[]> {
  assertSuperadmin(actor);
  const term = q.trim().toLowerCase();
  if (term.length < 2) throw badRequest('Digite ao menos 2 caracteres');
  return sql`
    select u.id, u.email, u.name, t.slug as "tenantSlug"
    from users u join tenants t on t.id = u.tenant_id
    where u.status = 'active'
      and not exists (select 1 from platform_superadmins sa where sa.user_id = u.id)
      and (u.email like ${`%${term}%`} or lower(u.name) like ${`%${term}%`})
    order by u.email
    limit 20`;
}

/** Hard guard: org permission checks must never accept platform codes. */
export function assertNotPlatformPermission(code: string): void {
  if (code.startsWith('platform.')) {
    throw forbidden('Permissão exclusiva de super admin');
  }
}
