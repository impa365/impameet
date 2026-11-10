import type { z } from 'zod';
import { createDefaultAgent } from '../agents/service';
import { audit } from '../audit';
import type { Sql } from '../db';
import { conflict, unauthorized } from '../errors';
import type { Plan } from '../plans';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../security/password';
import type { Tenant } from '../tenants/repo';
import type { loginInput, signupInput } from '../validation';
import type { SessionUser, UserRole } from './session';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/** Creates an organization (tenant), its branding and its first admin, atomically. */
export async function signup(
  sql: Sql,
  input: z.infer<typeof signupInput>,
  ip: string | null,
  plan: Plan = 'free',
): Promise<{ tenant: Tenant; user: SessionUser }> {
  const passwordHash = await hashPassword(input.password);
  try {
    return await sql.begin(async (tx) => {
      const [tenant] = await tx<Tenant[]>`
        insert into tenants (slug, name, plan) values (${input.slug}, ${input.organization}, ${plan})
        returning id, slug, name, status, plan`;
      await tx`
        insert into tenant_branding (tenant_id, product_name)
        values (${tenant.id}, ${input.organization.slice(0, 60)})`;
      const [user] = await tx<SessionUser[]>`
        insert into users (tenant_id, email, name, password_hash, role)
        values (${tenant.id}, ${input.email}, ${input.name}, ${passwordHash}, 'admin')
        returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
      await createDefaultAgent(tx as unknown as Sql, tenant.id);
      await audit(tx as unknown as Sql, {
        tenantId: tenant.id,
        actorId: user.id,
        action: 'tenant.created',
        target: tenant.slug,
        ip,
      });
      return { tenant, user };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Este endereço de organização já está em uso');
    throw err;
  }
}

export async function login(
  sql: Sql,
  tenant: Tenant,
  input: z.infer<typeof loginInput>,
  ip: string | null,
): Promise<SessionUser> {
  const [row] = await sql<(SessionUser & { passwordHash: string; status: string })[]>`
    select id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin",
           password_hash as "passwordHash", status
    from users where tenant_id = ${tenant.id} and email = ${input.email}`;

  const ok =
    row && row.status === 'active'
      ? await verifyPassword(input.password, row.passwordHash)
      : await verifyAgainstDummy(input.password);

  if (!ok || !row) {
    await audit(sql, {
      tenantId: tenant.id,
      actorId: row?.id ?? null,
      action: 'auth.login_failed',
      target: input.email,
      ip,
    });
    throw unauthorized('E-mail ou senha incorretos');
  }

  const { passwordHash: _hash, status: _status, ...user } = row;
  return { ...user, role: user.role as UserRole };
}

/** The moment a session really starts (after the second step, when there is one). */
export async function recordLogin(sql: Sql, user: SessionUser, ip: string | null, mfaMethod: string | null) {
  await sql`update users set last_login_at = now() where id = ${user.id}`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'auth.login',
    ...(mfaMethod ? { meta: { mfa: mfaMethod } } : {}),
    ip,
  });
}
