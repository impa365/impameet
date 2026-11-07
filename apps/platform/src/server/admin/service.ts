import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { forbidden } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import type { Branding } from '../tenants/repo';
import type { brandingInput } from '../validation';

export function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores podem fazer isso');
}

export function assertStaff(user: SessionUser): void {
  if (user.role !== 'admin' && user.role !== 'manager') throw forbidden();
}

export async function updateBranding(
  sql: Sql,
  actor: SessionUser,
  input: z.infer<typeof brandingInput>,
  ip: string | null,
): Promise<Branding> {
  assertAdmin(actor);
  const [row] = await sql<Branding[]>`
    insert into tenant_branding (tenant_id, product_name, primary_color, logo_url, default_locale, updated_at)
    values (${actor.tenantId}, ${input.productName}, ${input.primaryColor}, ${input.logoUrl},
            ${input.defaultLocale}, now())
    on conflict (tenant_id) do update set
      product_name = excluded.product_name, primary_color = excluded.primary_color,
      logo_url = excluded.logo_url, default_locale = excluded.default_locale, updated_at = now()
    returning product_name as "productName", primary_color as "primaryColor", logo_url as "logoUrl",
              default_locale as "defaultLocale"`;
  await audit(sql, { tenantId: actor.tenantId, actorId: actor.id, action: 'branding.updated', ip });
  return row;
}

export interface AuditRow {
  id: string;
  action: string;
  target: string | null;
  actorName: string | null;
  ip: string | null;
  createdAt: Date;
}

export async function listAudit(sql: Sql, actor: SessionUser, limit = 200): Promise<AuditRow[]> {
  assertAdmin(actor);
  return sql<AuditRow[]>`
    select a.id::text, a.action, a.target, u.name as "actorName", a.ip, a.created_at as "createdAt"
    from audit_log a left join users u on u.id = a.actor_id
    where a.tenant_id = ${actor.tenantId}
    order by a.created_at desc, a.id desc limit ${Math.min(Math.max(limit, 1), 1000)}`;
}

export interface LiveRoomSummary {
  slug: string;
  name: string;
  participants: Pick<LiveParticipant, 'name' | 'role' | 'isAgent' | 'handRaised'>[];
}

/** Rooms of this tenant that are open right now, with who is inside. */
export async function liveRooms(sql: Sql, lk: LiveKitAdmin, actor: SessionUser): Promise<LiveRoomSummary[]> {
  assertStaff(actor);
  const prefix = `${actor.tenantId}.`;
  const open = (await lk.listRooms()).filter((r) => r.name.startsWith(prefix)).slice(0, 50);
  if (open.length === 0) return [];
  const slugs = open.map((r) => r.name.slice(prefix.length));
  const names = new Map(
    (
      await sql<{ slug: string; name: string }[]>`
        select slug, name from rooms where tenant_id = ${actor.tenantId} and slug = any(${slugs})`
    ).map((r) => [r.slug, r.name]),
  );
  return Promise.all(
    open.map(async (r) => {
      const slug = r.name.slice(prefix.length);
      const participants = await lk.listParticipants(r.name);
      return {
        slug,
        name: names.get(slug) ?? slug,
        participants: participants.map(({ name, role, isAgent, handRaised }) => ({
          name,
          role,
          isAgent,
          handRaised,
        })),
      };
    }),
  );
}
