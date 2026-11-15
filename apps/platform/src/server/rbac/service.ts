import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { audit } from '../audit';
import {
  DEFAULT_ROLE_PERMISSIONS,
  type OrgPermission,
  ORG_PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  type SystemRoleKey,
} from './permissions';

export interface OrgRoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: OrgPermission[];
  userCount: number;
}

export interface OrgPermissionDef {
  code: OrgPermission;
  category: string;
  description: string;
}

/** Seeds admin / manager / member for a brand-new organization. */
export async function seedTenantRoles(sql: Sql, tenantId: string): Promise<void> {
  for (const key of SYSTEM_ROLE_KEYS) {
    const names: Record<SystemRoleKey, { name: string; description: string }> = {
      admin: { name: 'Administrador', description: 'Acesso completo à organização' },
      manager: { name: 'Gestor', description: 'Usuários e salas ao vivo' },
      member: { name: 'Usuário', description: 'Participante sem painel administrativo' },
    };
    const [role] = await sql<{ id: string }[]>`
      insert into org_roles (tenant_id, key, name, description, is_system)
      values (${tenantId}, ${key}, ${names[key].name}, ${names[key].description}, true)
      on conflict (tenant_id, key) do update set name = excluded.name
      returning id`;
    const perms = DEFAULT_ROLE_PERMISSIONS[key];
    if (perms.length === 0) continue;
    for (const code of perms) {
      await sql`
        insert into org_role_permissions (role_id, permission_code)
        values (${role.id}, ${code})
        on conflict do nothing`;
    }
  }
}

export async function listOrgPermissionDefs(sql: Sql): Promise<OrgPermissionDef[]> {
  return sql<OrgPermissionDef[]>`
    select code, category, description from org_permission_defs order by category, code`;
}

export async function listOrgRoles(sql: Sql, actor: SessionUser): Promise<OrgRoleRow[]> {
  await requirePermission(sql, actor, 'roles.manage');
  const roles = await sql<Omit<OrgRoleRow, 'permissions'>[]>`
    select r.id, r.key, r.name, r.description, r.is_system as "isSystem",
           (select count(*)::int from users u where u.tenant_id = r.tenant_id and u.role = r.key) as "userCount"
    from org_roles r
    where r.tenant_id = ${actor.tenantId}
    order by r.is_system desc, r.key`;
  const perms = await sql<{ roleId: string; code: OrgPermission }[]>`
    select rp.role_id as "roleId", rp.permission_code as code
    from org_role_permissions rp
    join org_roles r on r.id = rp.role_id
    where r.tenant_id = ${actor.tenantId}`;
  const byRole = new Map<string, OrgPermission[]>();
  for (const p of perms) {
    const list = byRole.get(p.roleId) ?? [];
    list.push(p.code);
    byRole.set(p.roleId, list);
  }
  return roles.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] }));
}

/** Permission codes granted to this user's org role (empty if role missing). */
export async function loadOrgPermissions(
  sql: Sql,
  tenantId: string,
  roleKey: string,
): Promise<OrgPermission[]> {
  const rows = await sql<{ code: OrgPermission }[]>`
    select rp.permission_code as code
    from org_roles r
    join org_role_permissions rp on rp.role_id = r.id
    where r.tenant_id = ${tenantId} and r.key = ${roleKey}
      and rp.permission_code not like 'platform.%'`;
  if (rows.length > 0) return rows.map((r) => r.code);
  if (roleKey === 'admin' || roleKey === 'manager' || roleKey === 'member') {
    return [...DEFAULT_ROLE_PERMISSIONS[roleKey]];
  }
  return [];
}

export async function permissionsForUser(sql: Sql, user: SessionUser): Promise<Set<OrgPermission>> {
  return new Set(await loadOrgPermissions(sql, user.tenantId, user.role));
}

export async function hasPermission(
  sql: Sql,
  user: SessionUser | null,
  permission: OrgPermission,
): Promise<boolean> {
  if (!user) return false;
  const set = await permissionsForUser(sql, user);
  return set.has(permission);
}

export async function requirePermission(
  sql: Sql,
  user: SessionUser | null,
  permission: OrgPermission,
): Promise<SessionUser> {
  if (!user) throw forbidden();
  if (!(await hasPermission(sql, user, permission))) {
    throw forbidden('Você não tem permissão para isso');
  }
  return user;
}

/** True when the role can open at least one admin surface. */
export async function canAccessAdminPanel(sql: Sql, user: SessionUser): Promise<boolean> {
  return hasPermission(sql, user, 'panel.access');
}

export async function createOrgRole(
  sql: Sql,
  actor: SessionUser,
  input: { key: string; name: string; description?: string; permissions: OrgPermission[] },
  ip: string | null,
): Promise<OrgRoleRow> {
  await requirePermission(sql, actor, 'roles.manage');
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || SYSTEM_ROLE_KEYS.includes(key as SystemRoleKey)) {
    throw badRequest('Chave de papel inválida');
  }
  if ((input.permissions as string[]).some((c) => String(c).startsWith('platform.'))) {
    throw forbidden('Permissões de plataforma não podem ir para papéis da organização');
  }
  const perms = input.permissions.filter((c) => (ORG_PERMISSIONS as readonly string[]).includes(c));
  try {
    const [role] = await sql<
      { id: string; key: string; name: string; description: string; isSystem: boolean }[]
    >`
      insert into org_roles (tenant_id, key, name, description, is_system)
      values (${actor.tenantId}, ${key}, ${input.name.trim()}, ${input.description?.trim() ?? ''}, false)
      returning id, key, name, description, is_system as "isSystem"`;
    for (const code of perms) {
      await sql`
        insert into org_role_permissions (role_id, permission_code) values (${role.id}, ${code})`;
    }
    await audit(sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'role.created',
      target: key,
      meta: { permissions: perms.join(',') },
      ip,
    });
    return { ...role, permissions: perms, userCount: 0 };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('Já existe um papel com essa chave');
    throw err;
  }
}

export async function updateOrgRolePermissions(
  sql: Sql,
  actor: SessionUser,
  roleKey: string,
  permissions: OrgPermission[],
  ip: string | null,
): Promise<OrgRoleRow> {
  await requirePermission(sql, actor, 'roles.manage');
  if (permissions.some((c) => String(c).startsWith('platform.'))) {
    throw forbidden('Permissões de plataforma não podem ir para papéis da organização');
  }
  const perms = [...new Set(permissions.filter((c) => (ORG_PERMISSIONS as readonly string[]).includes(c)))];
  // Member may stay empty; admin must keep panel.access + roles.manage so the org is not locked out.
  if (roleKey === 'admin') {
    if (
      !perms.includes('panel.access') ||
      !perms.includes('roles.manage') ||
      !perms.includes('users.assign_admin')
    ) {
      throw badRequest(
        'O papel Administrador precisa manter acesso ao painel, gestão de papéis e atribuição de admin',
      );
    }
  }
  return sql.begin(async (tx) => {
    const [role] = await tx<Omit<OrgRoleRow, 'permissions' | 'userCount'>[]>`
      select id, key, name, description, is_system as "isSystem"
      from org_roles where tenant_id = ${actor.tenantId} and key = ${roleKey} for update`;
    if (!role) throw notFound('Papel não encontrado');
    await tx`delete from org_role_permissions where role_id = ${role.id}`;
    for (const code of perms) {
      await tx`insert into org_role_permissions (role_id, permission_code) values (${role.id}, ${code})`;
    }
    await audit(tx as unknown as Sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'role.permissions_updated',
      target: roleKey,
      meta: { permissions: perms.join(',') },
      ip,
    });
    const [{ userCount }] = await tx<{ userCount: number }[]>`
      select count(*)::int as "userCount" from users
      where tenant_id = ${actor.tenantId} and role = ${roleKey}`;
    return { ...role, permissions: perms, userCount };
  });
}

export async function deleteOrgRole(
  sql: Sql,
  actor: SessionUser,
  roleKey: string,
  ip: string | null,
): Promise<void> {
  await requirePermission(sql, actor, 'roles.manage');
  if ((SYSTEM_ROLE_KEYS as readonly string[]).includes(roleKey)) {
    throw badRequest('Papéis do sistema não podem ser apagados');
  }
  await sql.begin(async (tx) => {
    const [role] = await tx<{ id: string; isSystem: boolean }[]>`
      select id, is_system as "isSystem" from org_roles
      where tenant_id = ${actor.tenantId} and key = ${roleKey} for update`;
    if (!role) throw notFound('Papel não encontrado');
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from users where tenant_id = ${actor.tenantId} and role = ${roleKey}`;
    if (n > 0) throw badRequest('Mova os usuários desse papel antes de apagá-lo');
    await tx`delete from org_roles where id = ${role.id}`;
    await audit(tx as unknown as Sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'role.deleted',
      target: roleKey,
      ip,
    });
  });
}

/** Role keys this actor may assign when creating/editing users. */
export async function assignableRoleKeys(sql: Sql, actor: SessionUser): Promise<string[]> {
  const roles = await sql<{ key: string }[]>`
    select key from org_roles where tenant_id = ${actor.tenantId} order by is_system desc, key`;
  const keys = roles.map((r) => r.key);
  if (await hasPermission(sql, actor, 'users.assign_admin')) return keys;
  return keys.filter((k) => k !== 'admin');
}
