import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { type TenantLimits, effectiveLimits, limitOverrides } from '../plans';
import type { tenantAdminInput } from '../validation';

export function assertSuperadmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user?.isSuperadmin) throw forbidden('Área exclusiva do super admin');
}

export interface TenantOverview {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
  limits: TenantLimits;
  users: number;
  rooms: number;
  domains: number;
  createdAt: Date;
}

export async function listTenants(sql: Sql, actor: SessionUser | null): Promise<TenantOverview[]> {
  assertSuperadmin(actor);
  const rows = await sql<(Omit<TenantOverview, 'limits'> & { overrides: unknown })[]>`
    select t.id, t.slug, t.name, t.status, t.plan, t.limits as overrides, t.created_at as "createdAt",
           (select count(*)::int from users u where u.tenant_id = t.id) as users,
           (select count(*)::int from rooms r where r.tenant_id = t.id) as rooms,
           (select count(*)::int from tenant_domains d where d.tenant_id = t.id) as domains
    from tenants t order by t.created_at desc limit 5000`;
  return rows.map(({ overrides, ...t }) => ({ ...t, limits: effectiveLimits(t.plan, overrides) }));
}

export async function updateTenant(
  sql: Sql,
  actor: SessionUser | null,
  tenantId: string,
  patch: z.infer<typeof tenantAdminInput>,
  ip: string | null,
): Promise<void> {
  assertSuperadmin(actor);
  if (tenantId === actor.tenantId && patch.status === 'suspended') {
    throw badRequest('Você não pode suspender a própria organização');
  }
  let limits: z.infer<typeof limitOverrides> | undefined;
  if (patch.limits) {
    const parsed = limitOverrides.safeParse(patch.limits);
    if (!parsed.success) throw badRequest('Limites inválidos');
    limits = parsed.data;
  }
  const result = await sql`
    update tenants set
      status = coalesce(${patch.status ?? null}::text, status),
      plan = coalesce(${patch.plan ?? null}::text, plan),
      limits = coalesce(${limits ? sql.json(limits) : null}::jsonb, limits)
    where id = ${tenantId}`;
  if (result.count === 0) throw notFound('Organização não encontrada');
  if (patch.status === 'suspended') {
    await sql`delete from sessions s using users u where s.user_id = u.id and u.tenant_id = ${tenantId}`;
  }
  await audit(sql, {
    tenantId,
    actorId: actor.id,
    action: 'tenant.updated',
    meta: {
      status: patch.status ?? null,
      plan: patch.plan ?? null,
      limits: limits ? JSON.stringify(limits) : null,
    },
    ip,
  });
}
