import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { findTenantAgent } from '../agents/service';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../errors';
import type { ParticipantRole } from '../livekit';
import { tenantLimits } from '../plans';
import { hashPassword, verifyPassword } from '../security/password';
import {
  type COLLAB_POLICIES,
  type ROOM_ACCESS,
  type createRoomInput,
  slugify,
  type updateRoomInput,
} from '../validation';

export type RoomAccess = (typeof ROOM_ACCESS)[number];
export type CollabPolicy = (typeof COLLAB_POLICIES)[number];

export interface Room {
  id: string;
  tenantId: string;
  ownerId: string | null;
  slug: string;
  name: string;
  hasPassword: boolean;
  allowGuests: boolean;
  access: RoomAccess;
  boardPolicy: CollabPolicy;
  pollsPolicy: CollabPolicy;
  /** True when at least one agent is in `agentIds`. */
  agentEnabled: boolean;
  /** The first of `agentIds` (kept for single-agent callers). */
  agentId: string | null;
  /** Every agent that joins this room's meetings, in the order they were added. */
  agentIds: string[];
  maxParticipants: number | null;
  createdAt: Date;
}

/** More agents in one call means more speech recognition and voice; this keeps it sane. */
export const MAX_ROOM_AGENTS = 4;

const ROOM_COLUMNS = (sql: Sql) => sql`
  id, tenant_id as "tenantId", owner_id as "ownerId", slug, name,
  password_hash is not null as "hasPassword", allow_guests as "allowGuests",
  access, board_policy as "boardPolicy", polls_policy as "pollsPolicy",
  array(select ra.agent_id::text from room_agents ra where ra.room_id = rooms.id
        order by ra.added_at, ra.agent_id) as "agentIds",
  max_participants as "maxParticipants", created_at as "createdAt"`;

/** Fills the derived agent fields. */
function withAgents<T extends Omit<Room, 'agentEnabled' | 'agentId'>>(
  room: T,
): T & Pick<Room, 'agentEnabled' | 'agentId'> {
  return { ...room, agentEnabled: room.agentIds.length > 0, agentId: room.agentIds[0] ?? null };
}

/**
 * Replaces the room's agents. Callers check who may change the room; this checks the plan
 * and that every agent belongs to the organization.
 */
async function writeRoomAgents(
  sql: Sql,
  room: Pick<Room, 'id' | 'tenantId'>,
  agentIds: string[],
): Promise<void> {
  const ids = [...new Set(agentIds)];
  if (ids.length > MAX_ROOM_AGENTS) throw forbidden(`Até ${MAX_ROOM_AGENTS} assistentes de IA por sala`);
  if (ids.length > 0) {
    if (!(await tenantLimits(sql, room.tenantId)).agents) {
      throw forbidden('O plano atual não inclui assistente de IA');
    }
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from agents where tenant_id = ${room.tenantId} and id in ${sql(ids)}`;
    if (count !== ids.length) throw notFound('Agente de IA não encontrado');
  }
  await sql.begin(async (tx) => {
    await tx`delete from room_agents where room_id = ${room.id}`;
    for (const [i, agentId] of ids.entries()) {
      await tx`
        insert into room_agents (room_id, agent_id, added_at)
        values (${room.id}, ${agentId}, now() + make_interval(secs => ${i} / 1000.0))`;
    }
    await tx`update rooms set agent_enabled = ${ids.length > 0} where id = ${room.id}`;
  });
}

/** The default agent's id, for callers that only say "AI on". */
async function defaultAgent(sql: Sql, tenantId: string): Promise<string[]> {
  const [row] = await sql<
    { id: string }[]
  >`select id from agents where tenant_id = ${tenantId} and is_default`;
  return row ? [row.id] : [];
}

/** Turns the old single-agent switches (agentEnabled / agentId) into an agent list. */
async function resolveAgentIds(
  sql: Sql,
  tenantId: string,
  current: string[],
  input: { agentIds?: string[]; agentEnabled?: boolean; agentId?: string | null },
): Promise<string[] | undefined> {
  if (input.agentIds !== undefined) return input.agentIds;
  if (input.agentEnabled === false) return [];
  if (input.agentId) return [input.agentId];
  if (input.agentEnabled === true || input.agentId === null) {
    return current.length > 0 && input.agentId === undefined ? current : defaultAgent(sql, tenantId);
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

async function assertTenantAgent(sql: Sql, tenantId: string, agentId: string | null | undefined) {
  if (!agentId) return;
  if (!(await findTenantAgent(sql, tenantId, agentId))) throw notFound('Agente de IA não encontrado');
}

/** Admins and managers run every room of their organization. */
export function canManageAllRooms(user: Pick<SessionUser, 'role'>): boolean {
  return user.role === 'admin' || user.role === 'manager';
}

export async function createRoom(
  sql: Sql,
  user: SessionUser,
  input: z.infer<typeof createRoomInput>,
  ip: string | null,
): Promise<Room> {
  const limits = await tenantLimits(sql, user.tenantId);
  if (input.agentEnabled && !limits.agents) throw forbidden('O plano atual não inclui assistente de IA');
  if (limits.maxRooms !== null) {
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from rooms where tenant_id = ${user.tenantId}`;
    if (count >= limits.maxRooms) throw forbidden(`O plano atual permite até ${limits.maxRooms} salas`);
  }
  await assertTenantAgent(sql, user.tenantId, input.agentId);
  const agentIds = (await resolveAgentIds(sql, user.tenantId, [], input)) ?? [];
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const base = input.slug ?? (slugify(input.name) || 'sala');
  const explicit = input.slug !== undefined;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base.slice(0, 57)}-${randomBytes(3).toString('hex')}`;
    try {
      const [created] = await sql<{ id: string }[]>`
        insert into rooms (tenant_id, owner_id, slug, name, password_hash, allow_guests,
                           access, board_policy, polls_policy, max_participants)
        values (${user.tenantId}, ${user.id}, ${slug}, ${input.name}, ${passwordHash},
                ${input.allowGuests}, ${input.access}, ${input.boardPolicy}, ${input.pollsPolicy},
                ${input.maxParticipants ?? null})
        returning id`;
      if (agentIds.length > 0)
        await writeRoomAgents(sql, { id: created.id, tenantId: user.tenantId }, agentIds);
      const room = (await findRoom(sql, user.tenantId, slug))!;
      await audit(sql, {
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'room.created',
        target: room.slug,
        ip,
      });
      return room;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (explicit) throw conflict('Já existe uma sala com esse endereço');
    }
  }
  throw conflict('Não foi possível gerar um endereço livre para a sala');
}

export async function findRoom(sql: Sql, tenantId: string, slug: string): Promise<Room | null> {
  const [room] = await sql<Omit<Room, 'agentEnabled' | 'agentId'>[]>`
    select ${ROOM_COLUMNS(sql)} from rooms where tenant_id = ${tenantId} and slug = ${slug}`;
  return room ? withAgents(room) : null;
}

export async function listRooms(sql: Sql, user: SessionUser): Promise<Room[]> {
  const rows = canManageAllRooms(user)
    ? await sql<Omit<Room, 'agentEnabled' | 'agentId'>[]>`
        select ${ROOM_COLUMNS(sql)} from rooms
        where tenant_id = ${user.tenantId} order by created_at desc limit 500`
    : await sql<Omit<Room, 'agentEnabled' | 'agentId'>[]>`
        select ${ROOM_COLUMNS(sql)} from rooms
        where tenant_id = ${user.tenantId} and owner_id = ${user.id}
        order by created_at desc limit 500`;
  return rows.map(withAgents);
}

/** Owner, admins and managers change room settings; `password: null` removes the password. */
export async function updateRoom(
  sql: Sql,
  user: SessionUser,
  slug: string,
  patch: z.infer<typeof updateRoomInput>,
  ip: string | null,
): Promise<Room> {
  const room = await findRoom(sql, user.tenantId, slug);
  if (!room) throw notFound('Sala não encontrada');
  if (room.ownerId !== user.id && !canManageAllRooms(user)) throw forbidden();
  await assertTenantAgent(sql, user.tenantId, patch.agentId);
  const agentIds = await resolveAgentIds(sql, user.tenantId, room.agentIds, patch);
  if (agentIds !== undefined) await writeRoomAgents(sql, room, agentIds);
  const passwordHash =
    patch.password === undefined
      ? undefined
      : patch.password === null
        ? null
        : await hashPassword(patch.password);

  await sql`
    update rooms set
      name = coalesce(${patch.name ?? null}::text, name),
      allow_guests = coalesce(${patch.allowGuests ?? null}::boolean, allow_guests),
      access = coalesce(${patch.access ?? null}::text, access),
      board_policy = coalesce(${patch.boardPolicy ?? null}::text, board_policy),
      polls_policy = coalesce(${patch.pollsPolicy ?? null}::text, polls_policy),
      max_participants = case when ${patch.maxParticipants !== undefined}::boolean
                              then ${patch.maxParticipants ?? null}::int else max_participants end,
      password_hash = case when ${passwordHash !== undefined}::boolean
                           then ${passwordHash ?? null}::text else password_hash end
    where id = ${room.id}`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'room.updated',
    target: slug,
    meta: Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [
        k,
        k === 'password' ? (v === null ? 'removed' : 'changed') : Array.isArray(v) ? v.join(',') : String(v),
      ]),
    ),
    ip,
  });
  return (await findRoom(sql, user.tenantId, slug))!;
}
export async function deleteRoom(
  sql: Sql,
  user: SessionUser,
  slug: string,
  ip: string | null,
): Promise<void> {
  const room = await findRoom(sql, user.tenantId, slug);
  if (!room) throw notFound('Sala não encontrada');
  if (room.ownerId !== user.id && !canManageAllRooms(user)) throw forbidden();
  await sql`delete from rooms where id = ${room.id}`;
  await audit(sql, { tenantId: user.tenantId, actorId: user.id, action: 'room.deleted', target: slug, ip });
}

/** Owner, admins and managers: they change the room's settings and always walk in. */
export function managesRoom(room: Pick<Room, 'ownerId' | 'tenantId'>, user: SessionUser | null): boolean {
  return !!user && user.tenantId === room.tenantId && (room.ownerId === user.id || canManageAllRooms(user));
}

export async function listInvites(sql: Sql, room: Room): Promise<string[]> {
  const rows = await sql<{ email: string }[]>`
    select email from room_invites where room_id = ${room.id} order by email`;
  return rows.map((r) => r.email);
}

export async function setInvites(
  sql: Sql,
  user: SessionUser,
  room: Room,
  emails: string[],
  ip: string | null,
): Promise<string[]> {
  if (!managesRoom(room, user)) throw forbidden();
  await sql.begin(async (tx) => {
    await tx`delete from room_invites where room_id = ${room.id}`;
    if (emails.length > 0) {
      await tx`insert into room_invites ${tx(emails.map((email) => ({ room_id: room.id, email })))}`;
    }
  });
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: user.id,
    action: 'room.invites',
    target: room.slug,
    meta: { count: String(emails.length) },
    ip,
  });
  return emails;
}

/**
 * Whether this person walks straight in, or has to ask a moderator first (Google Meet's
 * open / trusted / restricted access).
 */
export async function entersDirectly(
  sql: Sql,
  room: Room,
  user: SessionUser | null,
  role: ParticipantRole,
): Promise<boolean> {
  if (role === 'moderator' || room.access === 'open') return true;
  if (!user) return false;
  if (room.access === 'trusted') return true;
  const [row] = await sql<{ ok: number }[]>`
    select 1 as ok from room_invites where room_id = ${room.id} and email = ${user.email.toLowerCase()}`;
  return !!row;
}

export interface JoinDecision {
  role: ParticipantRole;
  identity: string;
}

/** Who may enter, and as what. Moderators skip the room password. */
export async function authorizeJoin(
  sql: Sql,
  room: Room,
  user: SessionUser | null,
  password: string | undefined,
): Promise<JoinDecision> {
  const suffix = randomBytes(3).toString('hex');
  if (user) {
    const moderator = room.ownerId === user.id || canManageAllRooms(user);
    if (!moderator) await checkRoomPassword(sql, room, password);
    return { role: moderator ? 'moderator' : 'participant', identity: `u-${user.id}-${suffix}` };
  }
  if (!room.allowGuests) throw unauthorized('Esta sala é só para membros da organização. Faça login.');
  await checkRoomPassword(sql, room, password);
  return { role: 'guest', identity: `g-${randomBytes(6).toString('hex')}` };
}

async function checkRoomPassword(sql: Sql, room: Room, password: string | undefined): Promise<void> {
  if (!room.hasPassword) return;
  const [row] = await sql<{ passwordHash: string }[]>`
    select password_hash as "passwordHash" from rooms where id = ${room.id}`;
  if (!password || !row || !(await verifyPassword(password, row.passwordHash))) {
    throw new AppError(401, 'room_password', 'Senha da sala incorreta');
  }
}
