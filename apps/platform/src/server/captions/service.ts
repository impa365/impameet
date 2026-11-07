import { roomAgents } from '../agents/service';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import type { LiveKitAdmin, LiveParticipant } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { canModerate } from '../moderation/service';
import { tenantLimits } from '../plans';
import type { Room } from '../rooms/service';

export const CAPTIONS_MODE = 'captions';

const isCaptioner = (p: LiveParticipant) => p.isAgent && p.mode === CAPTIONS_MODE;

async function assertModerator(sql: Sql, lk: LiveKitAdmin, room: Room, user: SessionUser | null) {
  if (!user || !(await canModerate(lk, room, user))) throw forbidden('Só moderadores ligam as legendas');
  if (!(await tenantLimits(sql, room.tenantId)).agents) {
    throw forbidden('O plano atual não inclui legendas e transcrição');
  }
  return user;
}

export async function captionsOn(lk: LiveKitAdmin, room: Room): Promise<boolean> {
  return (await lk.listParticipants(livekitRoomName(room.tenantId, room.slug))).some(isCaptioner);
}

/** Sends the captions worker into the room; it transcribes everyone and saves the transcript. */
export async function startCaptions(
  sql: Sql,
  lk: LiveKitAdmin,
  agentName: string,
  room: Room,
  user: SessionUser | null,
  ip: string | null,
): Promise<void> {
  const actor = await assertModerator(sql, lk, room, user);
  if (await captionsOn(lk, room)) throw conflict('As legendas já estão ligadas');
  // Transcription uses the Fish Audio account and model chosen for the room's agent: there is
  // no server-wide fallback.
  const [agent] = await roomAgents(sql, room);
  if (!agent) throw badRequest('Para transcrever, a sala precisa de um assistente de IA configurado');
  await sql`
    insert into caption_sessions (room_id, started_by) values (${room.id}, ${actor.id})
    on conflict (room_id) do update set started_by = excluded.started_by, started_at = now()`;
  await lk.dispatchAgent(
    livekitRoomName(room.tenantId, room.slug),
    agentName,
    JSON.stringify({ mode: CAPTIONS_MODE, agentId: agent.id }),
  );
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'captions.started',
    target: room.slug,
    ip,
  });
}

/** Removing the worker ends its job, which saves the transcript on the way out. */
export async function stopCaptions(
  sql: Sql,
  lk: LiveKitAdmin,
  room: Room,
  user: SessionUser | null,
  ip: string | null,
): Promise<void> {
  const actor = await assertModerator(sql, lk, room, user);
  const lkRoom = livekitRoomName(room.tenantId, room.slug);
  const workers = (await lk.listParticipants(lkRoom)).filter(isCaptioner);
  if (workers.length === 0) throw notFound('As legendas não estão ligadas');
  for (const w of workers) await lk.remove(lkRoom, w.identity);
  await audit(sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'captions.stopped',
    target: room.slug,
    ip,
  });
}
