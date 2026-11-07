import { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { forbidden, notFound } from '../errors';
import { canManageAllRooms } from '../rooms/service';

export const transcriptLine = z.object({
  at: z
    .number()
    .min(0)
    .max(7 * 24 * 3600),
  identity: z.string().max(200),
  name: z.string().max(200),
  text: z.string().max(5000),
});

export const transcriptInput = z.object({
  room: z.string().regex(/^[0-9a-f-]{36}\.[a-z0-9-]{1,64}$/),
  startedAt: z.number().positive(),
  endedAt: z.number().positive(),
  lines: z.array(transcriptLine).min(1).max(20_000),
});

export type TranscriptLine = z.infer<typeof transcriptLine>;

export interface TranscriptSummary {
  id: string;
  roomName: string;
  startedByName: string | null;
  startedAt: Date;
  endedAt: Date;
  lineCount: number;
}

/** Called by the captions worker (internal token) when it leaves a room. */
export async function saveTranscript(sql: Sql, input: z.infer<typeof transcriptInput>): Promise<string> {
  const [tenantId, slug] = input.room.split('.', 2);
  const [room] = await sql<{ id: string; name: string; startedBy: string | null }[]>`
    select r.id, r.name, c.started_by as "startedBy"
    from rooms r left join caption_sessions c on c.room_id = r.id
    where r.tenant_id = ${tenantId} and r.slug = ${slug}`;
  if (!room) throw notFound('Sala não encontrada');
  const [{ id }] = await sql<{ id: string }[]>`
    insert into transcripts (tenant_id, room_id, room_name, started_by, started_at, ended_at, lines, line_count)
    values (${tenantId}, ${room.id}, ${room.name}, ${room.startedBy},
            to_timestamp(${input.startedAt}), to_timestamp(${input.endedAt}),
            ${sql.json(input.lines)}, ${input.lines.length})
    returning id`;
  await sql`delete from caption_sessions where room_id = ${room.id}`;
  await audit(sql, { tenantId, actorId: room.startedBy, action: 'transcript.saved', target: slug, ip: null });
  return id;
}

/** Admins and managers see every transcript; others, the ones of meetings they captioned or own. */
export async function listTranscripts(sql: Sql, user: SessionUser): Promise<TranscriptSummary[]> {
  const all = canManageAllRooms(user);
  return sql<TranscriptSummary[]>`
    select t.id, t.room_name as "roomName", u.name as "startedByName", t.started_at as "startedAt",
           t.ended_at as "endedAt", t.line_count as "lineCount"
    from transcripts t
    left join users u on u.id = t.started_by
    left join rooms r on r.id = t.room_id
    where t.tenant_id = ${user.tenantId}
      and (${all}::boolean or t.started_by = ${user.id} or r.owner_id = ${user.id})
    order by t.started_at desc limit 200`;
}

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function formatTranscript(roomName: string, startedAt: Date, lines: TranscriptLine[]): string {
  const header = `Transcrição — ${roomName} — ${startedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
  return [header, '', ...lines.map((l) => `[${clock(l.at)}] ${l.name}: ${l.text}`), ''].join('\n');
}

async function visibleTranscript(sql: Sql, user: SessionUser, id: string) {
  const [row] = await sql<
    {
      roomName: string;
      startedAt: Date;
      lines: TranscriptLine[];
      startedBy: string | null;
      ownerId: string | null;
    }[]
  >`
    select t.room_name as "roomName", t.started_at as "startedAt", t.lines, t.started_by as "startedBy",
           r.owner_id as "ownerId"
    from transcripts t left join rooms r on r.id = t.room_id
    where t.id = ${id} and t.tenant_id = ${user.tenantId}`;
  const allowed = row && (canManageAllRooms(user) || row.startedBy === user.id || row.ownerId === user.id);
  if (!allowed) throw notFound('Transcrição não encontrada');
  return row;
}

export async function transcriptText(sql: Sql, user: SessionUser, id: string) {
  const row = await visibleTranscript(sql, user, id);
  return {
    roomName: row.roomName,
    startedAt: row.startedAt,
    text: formatTranscript(row.roomName, row.startedAt, row.lines),
  };
}

export async function deleteTranscript(
  sql: Sql,
  user: SessionUser,
  id: string,
  ip: string | null,
): Promise<void> {
  const row = await visibleTranscript(sql, user, id);
  if (!canManageAllRooms(user) && row.startedBy !== user.id) throw forbidden();
  await sql`delete from transcripts where id = ${id}`;
  await audit(sql, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: 'transcript.deleted',
    target: row.roomName,
    ip,
  });
}
