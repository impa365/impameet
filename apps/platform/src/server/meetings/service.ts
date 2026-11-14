import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, forbidden, notFound } from '../errors';
import { canManageAllRooms, findRoom } from '../rooms/service';
import type { meetingInput } from '../validation';

export interface Meeting {
  id: string;
  roomSlug: string;
  roomName: string;
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  invitees: string[];
  createdBy: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  /** In the organizer's Google Calendar, or why it could not be put there. */
  inGoogleCalendar: boolean;
  googleError: string | null;
}

const COLUMNS = (sql: Sql) => sql`
  m.id, r.slug as "roomSlug", r.name as "roomName", m.title, m.description,
  m.starts_at as "startsAt", m.duration_min as "durationMin", m.invitees,
  m.created_by as "createdBy", u.name as "createdByName", u.email as "createdByEmail",
  (m.google_event_id is not null) as "inGoogleCalendar", m.google_error as "googleError"`;

/** Grace so a meeting "starting now" can still be scheduled from a slow form. */
const PAST_GRACE_MS = 5 * 60_000;

export async function createMeeting(
  sql: Sql,
  user: SessionUser,
  input: z.infer<typeof meetingInput>,
  ip: string | null,
  now = new Date(),
): Promise<Meeting> {
  const room = await findRoom(sql, user.tenantId, input.roomSlug);
  if (!room) throw notFound('Sala não encontrada');
  if (room.ownerId !== user.id && !canManageAllRooms(user)) {
    throw forbidden('Você só agenda reuniões nas suas salas');
  }
  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() < now.getTime() - PAST_GRACE_MS) throw badRequest('Escolha uma data no futuro');
  const invitees = [...new Set(input.invitees)];
  const [{ id }] = await sql<{ id: string }[]>`
    insert into meetings (tenant_id, room_id, title, description, starts_at, duration_min, invitees, created_by)
    values (${user.tenantId}, ${room.id}, ${input.title}, ${input.description}, ${startsAt},
            ${input.durationMin}, ${invitees}, ${user.id})
    returning id`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'meeting.scheduled',
    target: room.slug,
    meta: { invitees: invitees.length },
    ip,
  });
  return findVisibleMeeting(sql, user, id);
}

/** Meetings that have not ended yet: all of them for admins/managers, otherwise one's own. */
export async function listMeetings(sql: Sql, user: SessionUser, now = new Date()): Promise<Meeting[]> {
  const all = canManageAllRooms(user);
  return sql<Meeting[]>`
    select ${COLUMNS(sql)}
    from meetings m join rooms r on r.id = m.room_id left join users u on u.id = m.created_by
    where m.tenant_id = ${user.tenantId}
      and m.starts_at + make_interval(mins => m.duration_min) > ${now}
      and (${all}::boolean or m.created_by = ${user.id} or r.owner_id = ${user.id})
    order by m.starts_at limit 200`;
}

export async function findVisibleMeeting(sql: Sql, user: SessionUser, id: string): Promise<Meeting> {
  const [row] = await sql<(Meeting & { ownerId: string | null })[]>`
    select ${COLUMNS(sql)}, r.owner_id as "ownerId"
    from meetings m join rooms r on r.id = m.room_id left join users u on u.id = m.created_by
    where m.id = ${id} and m.tenant_id = ${user.tenantId}`;
  const visible = row && (canManageAllRooms(user) || row.createdBy === user.id || row.ownerId === user.id);
  if (!visible) throw notFound('Reunião não encontrada');
  const { ownerId: _owner, ...meeting } = row;
  return meeting;
}

export async function cancelMeeting(
  sql: Sql,
  user: SessionUser,
  id: string,
  ip: string | null,
): Promise<{ googleEventId: string | null; googleUserId: string | null }> {
  const meeting = await findVisibleMeeting(sql, user, id);
  if (!canManageAllRooms(user) && meeting.createdBy !== user.id) throw forbidden();
  const [link] = await sql<{ googleEventId: string | null; googleUserId: string | null }[]>`
    delete from meetings where id = ${id}
    returning google_event_id as "googleEventId", google_user_id as "googleUserId"`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'meeting.cancelled',
    target: meeting.roomSlug,
    ip,
  });
  return link ?? { googleEventId: null, googleUserId: null };
}
