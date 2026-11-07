import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser, UserRole } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { hashPassword } from '../security/password';
import type { createUserInput, updateUserInput } from '../validation';

export interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'active' | 'disabled';
  createdAt: Date;
  lastLoginAt: Date | null;
}

const USER_COLUMNS = (sql: Sql) => sql`
  id, email, name, role, status, created_at as "createdAt", last_login_at as "lastLoginAt"`;

/** Admins manage everyone; managers manage plain users only. */
export function canManageUser(actor: SessionUser, targetRole: UserRole): boolean {
  if (actor.role === 'admin') return true;
  return actor.role === 'manager' && targetRole === 'member';
}

function assertStaff(actor: SessionUser): void {
  if (actor.role !== 'admin' && actor.role !== 'manager') throw forbidden();
}

export async function listUsers(sql: Sql, actor: SessionUser): Promise<ManagedUser[]> {
  assertStaff(actor);
  return sql<ManagedUser[]>`
    select ${USER_COLUMNS(sql)} from users where tenant_id = ${actor.tenantId}
    order by created_at limit 2000`;
}

export async function createUser(
  sql: Sql,
  actor: SessionUser,
  input: z.infer<typeof createUserInput>,
  ip: string | null,
): Promise<ManagedUser> {
  assertStaff(actor);
  if (!canManageUser(actor, input.role)) throw forbidden('Gestores só cadastram usuários comuns');
  try {
    const [user] = await sql<ManagedUser[]>`
      insert into users (tenant_id, email, name, password_hash, role)
      values (${actor.tenantId}, ${input.email}, ${input.name}, ${await hashPassword(input.password)}, ${input.role})
      returning ${USER_COLUMNS(sql)}`;
    await audit(sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'user.created',
      target: user.email,
      meta: { role: user.role },
      ip,
    });
    return user;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('Já existe um usuário com esse e-mail');
    throw err;
  }
}

export async function updateUser(
  sql: Sql,
  actor: SessionUser,
  userId: string,
  patch: z.infer<typeof updateUserInput>,
  ip: string | null,
): Promise<ManagedUser> {
  assertStaff(actor);
  return sql.begin(async (tx) => {
    const [target] = await tx<ManagedUser[]>`
      select ${USER_COLUMNS(tx as unknown as Sql)} from users
      where id = ${userId} and tenant_id = ${actor.tenantId} for update`;
    if (!target) throw notFound('Usuário não encontrado');
    if (!canManageUser(actor, target.role) || (patch.role && !canManageUser(actor, patch.role)))
      throw forbidden();
    if (target.id === actor.id && (patch.role || patch.status)) {
      throw badRequest('Você não pode mudar o próprio papel nem se desativar');
    }
    const losesAdmin =
      target.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.status === 'disabled');
    if (losesAdmin) {
      const [{ admins }] = await tx<{ admins: number }[]>`
        select count(*)::int as admins from users
        where tenant_id = ${actor.tenantId} and role = 'admin' and status = 'active'`;
      if (admins <= 1) throw badRequest('A organização precisa de pelo menos um admin ativo');
    }
    const passwordHash = patch.password ? await hashPassword(patch.password) : null;
    const [updated] = await tx<ManagedUser[]>`
      update users set
        name = coalesce(${patch.name ?? null}::text, name),
        role = coalesce(${patch.role ?? null}::text, role),
        status = coalesce(${patch.status ?? null}::text, status),
        password_hash = coalesce(${passwordHash}::text, password_hash)
      where id = ${target.id}
      returning ${USER_COLUMNS(tx as unknown as Sql)}`;
    if (patch.status === 'disabled' || patch.password) {
      await tx`delete from sessions where user_id = ${target.id}`;
    }
    await audit(tx as unknown as Sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'user.updated',
      target: target.email,
      meta: Object.fromEntries(
        Object.entries(patch).map(([k, v]) => [k, k === 'password' ? 'reset' : String(v)]),
      ),
      ip,
    });
    return updated;
  });
}
