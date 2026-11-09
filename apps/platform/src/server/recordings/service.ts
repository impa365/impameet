import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, conflict, forbidden, notFound } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { canModerate } from '../moderation/service';
import { tenantLimits } from '../plans';
import { type Room, canManageAllRooms } from '../rooms/service';
import type { RecordingEgress } from './egress';
import { recordingFileName } from './files';

export type RecordingStatus = 'starting' | 'recording' | 'processing' | 'ready' | 'failed';

export interface Recording {
  id: string;
  roomName: string;
  status: RecordingStatus;
  fileName: string;
  sizeBytes: number | null;
  durationS: number | null;
  error: string | null;
  startedBy: string | null;
  startedByName: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

const COLUMNS = (sql: Sql) => sql`
  r.id, r.room_name as "roomName", r.status, r.file_name as "fileName",
  r.size_bytes::float8 as "sizeBytes", r.duration_s as "durationS", r.error,
  r.started_by as "startedBy", u.name as "startedByName", r.started_at as "startedAt",
  r.ended_at as "endedAt"`;

const ACTIVE: RecordingStatus[] = ['starting', 'recording'];
const UNFINISHED: RecordingStatus[] = ['starting', 'recording', 'processing'];
/** Egress registers a recording as soon as it accepts it; after this, "unknown" means lost. */
export const RECORDING_GRACE_MS = 2 * 60_000;

export interface RecordingDeps {
  sql: Sql;
  lk: LiveKitAdmin;
  egress: RecordingEgress;
  /** Where Egress writes, as seen from the Egress container (e.g. /out). */
  outputDir: string;
}

async function assertCanRecord(deps: RecordingDeps, room: Room, user: SessionUser | null) {
  if (!user || !(await canModerate(deps.lk, room, user))) throw forbidden('Só moderadores podem gravar');
  if (!(await tenantLimits(deps.sql, room.tenantId)).recording) {
    throw forbidden('O plano atual não inclui gravação');
  }
  return user;
}

export async function activeRecording(sql: Sql, room: Room): Promise<Recording | null> {
  const [row] = await sql<Recording[]>`
    select ${COLUMNS(sql)} from recordings r left join users u on u.id = r.started_by
    where r.room_id = ${room.id} and r.status in ${sql(ACTIVE)}`;
  return row ?? null;
}

export async function startRecording(
  deps: RecordingDeps,
  room: Room,
  user: SessionUser | null,
  ip: string | null,
): Promise<Recording> {
  const actor = await assertCanRecord(deps, room, user);
  return beginRecording(deps, room, actor.id, ip);
}

/** Starts recording for `actorId` (already allowed to). `meta` says how (e.g. through an AI). */
export async function beginRecording(
  deps: RecordingDeps,
  room: Room,
  actorId: string | null,
  ip: string | null,
  meta?: Record<string, string>,
): Promise<Recording> {
  if (!(await tenantLimits(deps.sql, room.tenantId)).recording) {
    throw forbidden('O plano atual não inclui gravação');
  }
  const { sql } = deps;
  await settleRoom(deps, room);
  let id: string;
  try {
    [{ id }] = await sql<{ id: string }[]>`
      insert into recordings (tenant_id, room_id, room_name, file_name, started_by)
      values (${room.tenantId}, ${room.id}, ${room.name}, '', ${actorId})
      returning id`;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('A sala já está sendo gravada');
    throw err;
  }
  const fileName = recordingFileName(room.tenantId, id);
  try {
    const egressId = await deps.egress.start(
      livekitRoomName(room.tenantId, room.slug),
      `${deps.outputDir}/${fileName}`,
    );
    await sql`
      update recordings set file_name = ${fileName}, egress_id = ${egressId}, status = 'recording'
      where id = ${id}`;
  } catch {
    await sql`update recordings set status = 'failed', error = 'start_failed', ended_at = now() where id = ${id}`;
    throw new AppError(502, 'recording_unavailable', 'Não foi possível iniciar a gravação agora');
  }
  await audit(sql, {
    tenantId: room.tenantId,
    actorId,
    action: 'recording.started',
    target: room.slug,
    ip,
    meta,
  });
  return (await activeRecording(sql, room))!;
}

export async function stopRecording(
  deps: RecordingDeps,
  room: Room,
  user: SessionUser | null,
  ip: string | null,
): Promise<void> {
  const actor = await assertCanRecord(deps, room, user);
  await endRecording(deps, room, actor.id, ip);
}

export async function endRecording(
  deps: RecordingDeps,
  room: Room,
  actorId: string | null,
  ip: string | null,
  meta?: Record<string, string>,
): Promise<void> {
  await settleRoom(deps, room);
  const active = await activeRecording(deps.sql, room);
  if (!active) throw notFound('A sala não está sendo gravada');
  const [{ egressId }] = await deps.sql<{ egressId: string | null }[]>`
    select egress_id as "egressId" from recordings where id = ${active.id}`;
  if (egressId) await deps.egress.stop(egressId).catch(() => undefined);
  await deps.sql`update recordings set status = 'processing' where id = ${active.id}`;
  await audit(deps.sql, {
    tenantId: room.tenantId,
    actorId,
    action: 'recording.stopped',
    target: room.slug,
    ip,
    meta,
  });
}

interface Unfinished {
  id: string;
  egressId: string | null;
  startedAt: Date;
}

async function markFailed(sql: Sql, id: string, error: string): Promise<void> {
  await sql`
    update recordings set status = 'failed', error = ${error}, ended_at = coalesce(ended_at, now())
    where id = ${id} and status in ${sql(UNFINISHED)}`;
}

/**
 * Brings unfinished recordings in line with Egress (no webhook needed). A recording Egress
 * reports as failed, or no longer knows about, or that never got an Egress id, is marked
 * failed with the reason, which frees the room for a new recording. When Egress cannot be
 * reached nothing changes: an unreachable recorder may still be recording.
 */
async function settle(
  deps: Pick<RecordingDeps, 'sql' | 'egress'>,
  rows: Unfinished[],
  now = Date.now(),
): Promise<void> {
  for (const row of rows) {
    const old = now - new Date(row.startedAt).getTime() > RECORDING_GRACE_MS;
    if (!row.egressId) {
      if (old) await markFailed(deps.sql, row.id, 'start_timeout');
      continue;
    }
    let info: Awaited<ReturnType<RecordingEgress['info']>>;
    try {
      info = await deps.egress.info(row.egressId);
    } catch {
      continue;
    }
    if (!info) {
      if (old) await markFailed(deps.sql, row.id, 'egress_lost');
      continue;
    }
    const done = info.state === 'ready' || info.state === 'failed';
    await deps.sql`
      update recordings set status = ${info.state}, size_bytes = ${info.sizeBytes},
        duration_s = ${info.durationS},
        error = ${info.state === 'failed' ? (info.error ?? 'egress_failed').slice(0, 500) : null},
        ended_at = case when ${done}::boolean then coalesce(ended_at, now()) else ended_at end
      where id = ${row.id} and status in ${deps.sql(UNFINISHED)}`;
  }
}

async function refresh(deps: Pick<RecordingDeps, 'sql' | 'egress'>, tenantId: string): Promise<void> {
  await settle(
    deps,
    await deps.sql<Unfinished[]>`
      select id, egress_id as "egressId", started_at as "startedAt" from recordings
      where tenant_id = ${tenantId} and status in ${deps.sql(UNFINISHED)}`,
  );
}

/** Checks this room's unfinished recordings with Egress before deciding anything about it. */
export async function settleRoom(deps: Pick<RecordingDeps, 'sql' | 'egress'>, room: Room, now?: number) {
  await settle(
    deps,
    await deps.sql<Unfinished[]>`
      select id, egress_id as "egressId", started_at as "startedAt" from recordings
      where room_id = ${room.id} and status in ${deps.sql(UNFINISHED)}`,
    now,
  );
}

/** The room's last recording, if it failed in the last ten minutes (to tell the moderator why). */
export async function recentFailure(sql: Sql, room: Room): Promise<Recording | null> {
  const [row] = await sql<Recording[]>`
    select ${COLUMNS(sql)} from recordings r left join users u on u.id = r.started_by
    where r.room_id = ${room.id} order by r.started_at desc limit 1`;
  const recent = row?.endedAt && Date.now() - new Date(row.endedAt).getTime() < 10 * 60_000;
  return row?.status === 'failed' && recent ? row : null;
}

/** Admins and managers see the whole organization; everyone else, what they recorded. */
export async function listRecordings(
  deps: Pick<RecordingDeps, 'sql' | 'egress'>,
  user: SessionUser,
): Promise<Recording[]> {
  await refresh(deps, user.tenantId);
  const all = canManageAllRooms(user);
  return deps.sql<Recording[]>`
    select ${COLUMNS(deps.sql)} from recordings r left join users u on u.id = r.started_by
    where r.tenant_id = ${user.tenantId} and (${all}::boolean or r.started_by = ${user.id})
    order by r.started_at desc limit 200`;
}

export async function findVisibleRecording(sql: Sql, user: SessionUser, id: string): Promise<Recording> {
  const [row] = await sql<Recording[]>`
    select ${COLUMNS(sql)} from recordings r left join users u on u.id = r.started_by
    where r.id = ${id} and r.tenant_id = ${user.tenantId}`;
  if (!row || (!canManageAllRooms(user) && row.startedBy !== user.id))
    throw notFound('Gravação não encontrada');
  return row;
}

export async function deleteRecording(
  sql: Sql,
  user: SessionUser,
  id: string,
  removeFile: (fileName: string) => Promise<void>,
  ip: string | null,
): Promise<void> {
  const rec = await findVisibleRecording(sql, user, id);
  if (ACTIVE.includes(rec.status) || rec.status === 'processing') {
    throw conflict('Pare a gravação antes de apagar');
  }
  if (rec.fileName) await removeFile(rec.fileName);
  await sql`delete from recordings where id = ${id}`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'recording.deleted',
    target: rec.roomName,
    ip,
  });
}
