import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound, tooManyRequests } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import { canModerate } from '../moderation/service';
import { tenantLimits } from '../plans';
import type { StreamEgress } from '../recordings/egress';
import { publishRoomState, publishRoomStateById } from '../room-state';
import type { Room } from '../rooms/service';
import { RateLimiter } from '../security/rate-limit';
import { type Resolver, isPublicIp, systemResolver } from '../security/public-url';
import { openSecret, sealSecret, secretHint } from '../security/secrets';
import { GoogleError, accessToken, authUrl, exchangeCode, oauthStart, revoke } from '../storage/google';
import {
  STATE_TTL_MS,
  type StorageDeps,
  googleClient,
  needKey,
  platformGoogleRow,
  stateAad,
} from '../storage/service';
import type { liveStartInput, rtmpDestinationInput, youtubeStartInput } from '../validation';
import { YOUTUBE_SCOPE, YOUTUBE_SCOPES, createLive, endLive, myChannel } from './youtube';

export interface LiveDeps extends StorageDeps {
  lk: LiveKitAdmin;
  /** Null when this installation has no Egress (nothing can go live). */
  egress: StreamEgress | null;
  /** The studio's stage page, which Egress opens to stream a studio. */
  studioUrl: string;
}

export type DestinationKind = 'rtmp' | 'youtube';
export const MAX_DESTINATIONS = 10;
/** Egress registers a stream as soon as it accepts it; after this, "unknown" means lost. */
const LIVE_GRACE_MS = 2 * 60_000;
const destinationAad = (tenantId: string, id: string) => `stream:${tenantId}:${id}`;
const connects = new RateLimiter(10, 10 * 60_000);
const starts = new RateLimiter(10, 10 * 60_000);

interface DestinationRow {
  id: string;
  tenantId: string;
  kind: DestinationKind;
  name: string;
  rtmpUrl: string | null;
  googleEmail: string | null;
  channelTitle: string | null;
  sealed: string;
  secretHint: string;
  createdAt: Date;
}

const DEST_COLUMNS = (sql: Sql) => sql`
  id, tenant_id as "tenantId", kind, name, rtmp_url as "rtmpUrl", google_email as "googleEmail",
  channel_title as "channelTitle", secret_sealed as sealed, secret_hint as "secretHint", created_at as "createdAt"`;

/** What the panel shows: never a key or token, only the key's last characters. */
export type Destination = Omit<DestinationRow, 'tenantId' | 'sealed'>;

const visible = ({ tenantId: _t, sealed: _s, ...rest }: DestinationRow): Destination => rest;

function assertAdmin(user: SessionUser) {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram os destinos das transmissões');
}

async function destinations(sql: Sql, tenantId: string): Promise<DestinationRow[]> {
  return sql<DestinationRow[]>`
    select ${DEST_COLUMNS(sql)} from stream_destinations where tenant_id = ${tenantId} order by created_at`;
}

/**
 * RTMP servers come from organization admins and Egress connects to them: rtmp:// or rtmps://
 * on the public internet only (never the database or other internal services).
 */
export async function assertPublicRtmpUrl(raw: string, resolve: Resolver = systemResolver): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest('Endereço RTMP inválido');
  }
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:')
    throw badRequest('Use um endereço rtmp:// ou rtmps://');
  if (url.username || url.password) throw badRequest('O endereço não pode ter usuário ou senha');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0 || !addresses.every(isPublicIp)) {
    throw badRequest('O endereço RTMP precisa apontar para um servidor público na internet');
  }
  return url.toString().replace(/\/+$/, '');
}

// --- Destinations (admin) ----------------------------------------------------------------

export interface DestinationsView {
  encryption: boolean;
  /** The super admin configured the Google client (YouTube can be connected). */
  googleAvailable: boolean;
  /** This installation can stream at all. */
  streaming: boolean;
  destinations: Destination[];
}

export async function listDestinations(deps: LiveDeps, actor: SessionUser): Promise<DestinationsView> {
  assertAdmin(actor);
  return {
    encryption: deps.key !== null,
    googleAvailable: Boolean(await platformGoogleRow(deps.sql)),
    streaming: deps.egress !== null,
    destinations: (await destinations(deps.sql, actor.tenantId)).map(visible),
  };
}

async function assertRoomForMore(sql: Sql, tenantId: string) {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from stream_destinations where tenant_id = ${tenantId}`;
  if (n >= MAX_DESTINATIONS) throw badRequest(`Até ${MAX_DESTINATIONS} destinos por organização`);
}

export async function addRtmp(
  deps: LiveDeps,
  actor: SessionUser,
  input: z.infer<typeof rtmpDestinationInput>,
  ip: string | null,
): Promise<DestinationsView> {
  assertAdmin(actor);
  const key = needKey(deps);
  await assertRoomForMore(deps.sql, actor.tenantId);
  const url = await assertPublicRtmpUrl(input.url, deps.resolve);
  const id = randomUUID();
  await deps.sql`
    insert into stream_destinations (id, tenant_id, kind, name, rtmp_url, secret_sealed, secret_hint, created_by)
    values (${id}, ${actor.tenantId}, 'rtmp', ${input.name}, ${url},
            ${sealSecret(key, input.streamKey, destinationAad(actor.tenantId, id))}, ${secretHint(input.streamKey)},
            ${actor.id})`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'live.destination_added',
    target: input.name,
    meta: { kind: 'rtmp', host: new URL(url).hostname },
    ip,
  });
  return listDestinations(deps, actor);
}

export async function removeDestination(
  deps: LiveDeps,
  actor: SessionUser,
  id: string,
  ip: string | null,
): Promise<DestinationsView> {
  assertAdmin(actor);
  const [row] = await deps.sql<DestinationRow[]>`
    select ${DEST_COLUMNS(deps.sql)} from stream_destinations where id = ${id} and tenant_id = ${actor.tenantId}`;
  if (!row) throw notFound('Destino não encontrado');
  if (row.kind === 'youtube' && deps.key) {
    try {
      await revoke(
        deps.fetch ?? fetch,
        openSecret(deps.key, row.sealed, destinationAad(row.tenantId, row.id)),
      );
    } catch {
      // The stored token goes away below either way.
    }
  }
  await deps.sql`delete from stream_destinations where id = ${id}`;
  await audit(deps.sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'live.destination_removed',
    target: row.name,
    meta: { kind: row.kind },
    ip,
  });
  return listDestinations(deps, actor);
}

// --- Conectar YouTube ----------------------------------------------------------------------

export async function startYoutube(
  deps: LiveDeps,
  actor: SessionUser,
  input: z.infer<typeof youtubeStartInput>,
  returnUrl: string,
): Promise<{ url: string }> {
  assertAdmin(actor);
  if (!connects.take(actor.id)) throw tooManyRequests();
  const key = needKey(deps);
  await assertRoomForMore(deps.sql, actor.tenantId);
  const client = await googleClient(deps);
  if (!client) throw badRequest('O super admin ainda não configurou o Google nesta plataforma');
  const { state, verifier, challenge } = oauthStart();
  await deps.sql`delete from oauth_states where created_at < now() - make_interval(secs => ${STATE_TTL_MS / 1000})`;
  await deps.sql`
    insert into oauth_states (id, tenant_id, user_id, purpose, verifier_sealed, return_url, keep_local, label)
    values (${state}, ${actor.tenantId}, ${actor.id}, 'youtube', ${sealSecret(key, verifier, stateAad(state))},
            ${returnUrl}, false, ${input.name})`;
  return { url: authUrl(client, state, challenge, YOUTUBE_SCOPES) };
}

const withStatus = (url: string, status: string) => {
  const u = new URL(url);
  u.searchParams.set('youtube', status);
  return u.toString();
};

/** Google sends the admin back here: the one-time state is used up, the channel is saved. */
export async function finishYoutube(
  deps: LiveDeps,
  params: { state: string | null; code: string | null; error: string | null },
  ip: string | null,
): Promise<string> {
  const key = needKey(deps);
  if (!params.state || params.state.length > 100) throw badRequest('Conexão inválida ou expirada');
  const [row] = await deps.sql<
    {
      tenantId: string;
      userId: string;
      verifierSealed: string;
      returnUrl: string;
      label: string | null;
      createdAt: Date;
    }[]
  >`
    delete from oauth_states where id = ${params.state} and purpose = 'youtube'
    returning tenant_id as "tenantId", user_id as "userId", verifier_sealed as "verifierSealed",
              return_url as "returnUrl", label, created_at as "createdAt"`;
  if (!row || Date.now() - new Date(row.createdAt).getTime() > STATE_TTL_MS)
    throw badRequest('Conexão inválida ou expirada; comece de novo');
  if (params.error || !params.code) return withStatus(row.returnUrl, 'cancelled');
  const [admin] = await deps.sql<{ ok: boolean }[]>`
    select true as ok from users where id = ${row.userId} and tenant_id = ${row.tenantId} and role = 'admin'`;
  if (!admin) return withStatus(row.returnUrl, 'error');
  const client = await googleClient(deps);
  if (!client) return withStatus(row.returnUrl, 'error');
  const fetchImpl = deps.fetch ?? fetch;
  try {
    const verifier = openSecret(key, row.verifierSealed, stateAad(params.state));
    const granted = await exchangeCode(fetchImpl, client, params.code, verifier);
    if (!granted.scopes.includes(YOUTUBE_SCOPE)) {
      await revoke(fetchImpl, granted.refreshToken);
      return withStatus(row.returnUrl, 'scope');
    }
    let channel: { id: string; title: string };
    try {
      channel = await myChannel(fetchImpl, granted.accessToken);
    } catch {
      await revoke(fetchImpl, granted.refreshToken);
      return withStatus(row.returnUrl, 'nochannel');
    }
    const id = randomUUID();
    const name = (row.label?.trim() || `YouTube · ${channel.title}`).slice(0, 80);
    await deps.sql`
      insert into stream_destinations (id, tenant_id, kind, name, google_email, channel_id, channel_title,
                                       secret_sealed, created_by)
      values (${id}, ${row.tenantId}, 'youtube', ${name}, ${granted.email}, ${channel.id}, ${channel.title.slice(0, 200)},
              ${sealSecret(key, granted.refreshToken, destinationAad(row.tenantId, id))}, ${row.userId})`;
    await audit(deps.sql, {
      tenantId: row.tenantId,
      actorId: row.userId,
      action: 'live.destination_added',
      target: name,
      meta: { kind: 'youtube', account: granted.email ?? '', channel: channel.title },
      ip,
    });
    return withStatus(row.returnUrl, 'connected');
  } catch {
    return withStatus(row.returnUrl, 'error');
  }
}

// --- Going live (room moderators) --------------------------------------------------------

export interface LiveTarget {
  destinationId: string;
  kind: DestinationKind;
  name: string;
  broadcastId?: string;
  watchUrl?: string;
}

export interface LiveStream {
  id: string;
  status: 'starting' | 'live' | 'ended' | 'failed';
  title: string;
  targets: LiveTarget[];
  startedAt: Date;
  startedByName: string | null;
}

interface LiveRow extends LiveStream {
  tenantId: string;
  roomId: string;
  egressId: string | null;
}

const LIVE_COLUMNS = (sql: Sql) => sql`
  l.id, l.tenant_id as "tenantId", l.room_id as "roomId", l.status, l.egress_id as "egressId", l.title,
  l.targets, l.started_at as "startedAt", u.name as "startedByName"`;

const publicLive = ({ tenantId: _t, roomId: _r, egressId: _e, ...rest }: LiveRow): LiveStream => ({
  ...rest,
  targets: rest.targets.map(({ broadcastId: _b, ...t }) => t),
});

async function activeRow(sql: Sql, roomId: string): Promise<LiveRow | null> {
  const [row] = await sql<LiveRow[]>`
    select ${LIVE_COLUMNS(sql)} from live_streams l left join users u on u.id = l.started_by
    where l.room_id = ${roomId} and l.status in ('starting', 'live')`;
  return row ?? null;
}

async function mayGoLive(deps: LiveDeps, room: Room, user: SessionUser | null): Promise<boolean> {
  if (!user || !deps.egress) return false;
  if (!(await tenantLimits(deps.sql, room.tenantId)).recording) return false;
  return canModerate(deps.lk, room, user);
}

async function assertCanLive(deps: LiveDeps, room: Room, user: SessionUser | null): Promise<SessionUser> {
  if (!deps.egress)
    throw new AppError(501, 'live_disabled', 'A transmissão ao vivo não está instalada neste servidor');
  if (!user || !(await canModerate(deps.lk, room, user)))
    throw forbidden('Só moderadores podem transmitir ao vivo');
  if (!(await tenantLimits(deps.sql, room.tenantId)).recording)
    throw forbidden('O plano atual não inclui transmissões ao vivo');
  return user;
}

export interface RoomLiveView {
  canLive: boolean;
  destinations: Pick<Destination, 'id' | 'kind' | 'name'>[];
  active: LiveStream | null;
  /** Why the last live of the room fell, if it did in the last minutes. */
  failure: string | null;
}

/** What the room's live panel shows; destinations only to who may go live. */
export async function roomLive(deps: LiveDeps, room: Room, user: SessionUser | null): Promise<RoomLiveView> {
  await settleLives(deps, room.id);
  const canLive = await mayGoLive(deps, room, user);
  const row = await activeRow(deps.sql, room.id);
  return {
    canLive,
    destinations: canLive
      ? (await destinations(deps.sql, room.tenantId)).map(({ id, kind, name }) => ({ id, kind, name }))
      : [],
    active: row ? publicLive(row) : null,
    failure: canLive && !row ? await recentLiveFailure(deps.sql, room) : null,
  };
}

async function youtubeToken(deps: LiveDeps, key: Buffer, row: DestinationRow): Promise<string> {
  const client = await googleClient(deps);
  if (!client) throw new GoogleError('O Google não está configurado nesta plataforma');
  return accessToken(
    deps.fetch ?? fetch,
    client,
    openSecret(key, row.sealed, destinationAad(row.tenantId, row.id)),
  );
}

/** Ends the YouTube broadcasts of a live (best effort: YouTube also stops them with the video). */
async function endBroadcasts(deps: LiveDeps, tenantId: string, targets: LiveTarget[]): Promise<void> {
  if (!deps.key) return;
  for (const t of targets) {
    if (t.kind !== 'youtube' || !t.broadcastId) continue;
    try {
      const [row] = await deps.sql<DestinationRow[]>`
        select ${DEST_COLUMNS(deps.sql)} from stream_destinations where id = ${t.destinationId} and tenant_id = ${tenantId}`;
      if (row) await endLive(deps.fetch ?? fetch, await youtubeToken(deps, deps.key, row), t.broadcastId);
    } catch {
      // Nothing more to do: YouTube ends a broadcast whose video stopped.
    }
  }
}

export async function startLive(
  deps: LiveDeps,
  room: Room,
  user: SessionUser | null,
  input: z.infer<typeof liveStartInput>,
  ip: string | null,
): Promise<LiveStream> {
  const actor = await assertCanLive(deps, room, user);
  if (!starts.take(room.id)) throw tooManyRequests();
  const key = needKey(deps);
  await settleLives(deps, room.id);
  // In the order they were picked (that is the order shown to everyone).
  const all = await destinations(deps.sql, room.tenantId);
  const chosen = input.destinationIds
    .map((id) => all.find((d) => d.id === id))
    .filter((d): d is DestinationRow => d !== undefined);
  if (chosen.length !== input.destinationIds.length) throw notFound('Destino não encontrado');
  if (chosen.some((d) => d.kind === 'youtube') && !input.privacy)
    throw badRequest('Escolha quem pode ver a live no YouTube');

  let id: string;
  try {
    [{ id }] = await deps.sql<{ id: string }[]>`
      insert into live_streams (tenant_id, room_id, status, title, started_by)
      values (${room.tenantId}, ${room.id}, 'starting', ${input.title}, ${actor.id}) returning id`;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw conflict('A sala já está ao vivo');
    throw err;
  }

  const urls: string[] = [];
  const targets: LiveTarget[] = [];
  try {
    for (const d of chosen) {
      if (d.kind === 'rtmp') {
        // Checked again now: the name could point somewhere else since it was saved.
        const server = await assertPublicRtmpUrl(d.rtmpUrl ?? '', deps.resolve);
        urls.push(`${server}/${openSecret(key, d.sealed, destinationAad(d.tenantId, d.id))}`);
        targets.push({ destinationId: d.id, kind: 'rtmp', name: d.name });
      } else {
        const live = await createLive(deps.fetch ?? fetch, await youtubeToken(deps, key, d), {
          title: input.title,
          description: input.description,
          privacy: input.privacy!,
        });
        urls.push(live.ingestUrl);
        targets.push({
          destinationId: d.id,
          kind: 'youtube',
          name: d.name,
          broadcastId: live.broadcastId,
          watchUrl: live.watchUrl,
        });
      }
    }
    const egressId = await deps.egress!.stream(
      livekitRoomName(room.tenantId, room.slug),
      urls,
      room.studio ? deps.studioUrl : undefined,
    );
    await deps.sql`
      update live_streams set status = 'live', egress_id = ${egressId}, targets = ${deps.sql.json(targets as never)}
      where id = ${id}`;
  } catch (err) {
    await endBroadcasts(deps, room.tenantId, targets);
    const message =
      err instanceof AppError || err instanceof GoogleError
        ? err.message
        : 'Não foi possível iniciar a transmissão agora';
    await deps.sql`
      update live_streams set status = 'failed', error = ${message.slice(0, 500)}, ended_at = now(),
        targets = ${deps.sql.json(targets as never)}
      where id = ${id}`;
    if (err instanceof AppError) throw err;
    throw new AppError(err instanceof GoogleError ? 400 : 502, 'live_unavailable', message);
  }
  await audit(deps.sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'live.started',
    target: room.slug,
    meta: { to: targets.map((t) => t.name).join(', ') },
    ip,
  });
  await publishRoomState(deps.sql, deps.lk, room);
  return publicLive((await activeRow(deps.sql, room.id))!);
}

export async function stopLive(deps: LiveDeps, room: Room, user: SessionUser | null, ip: string | null) {
  const actor = await assertCanLive(deps, room, user);
  await settleLives(deps, room.id);
  const row = await activeRow(deps.sql, room.id);
  if (!row) throw notFound('A sala não está ao vivo');
  if (row.egressId) await deps.egress!.stop(row.egressId).catch(() => undefined);
  await deps.sql`update live_streams set status = 'ended', ended_at = now() where id = ${row.id}`;
  await endBroadcasts(deps, room.tenantId, row.targets);
  await audit(deps.sql, {
    tenantId: room.tenantId,
    actorId: actor.id,
    action: 'live.stopped',
    target: room.slug,
    ip,
  });
  await publishRoomState(deps.sql, deps.lk, room);
}

/**
 * Brings running lives in line with Egress (no webhook): a stream Egress reports finished,
 * failed or no longer knows is closed, its YouTube broadcasts ended, and the room told. When
 * Egress cannot be reached nothing changes. `roomId` limits it to one room.
 */
export async function settleLives(deps: LiveDeps, roomId?: string, now = Date.now()): Promise<number> {
  if (!deps.egress) return 0;
  const rows = await deps.sql<LiveRow[]>`
    select ${LIVE_COLUMNS(deps.sql)} from live_streams l left join users u on u.id = l.started_by
    where l.status in ('starting', 'live') and (${roomId ?? null}::uuid is null or l.room_id = ${roomId ?? null})`;
  let closed = 0;
  for (const row of rows) {
    const old = now - new Date(row.startedAt).getTime() > LIVE_GRACE_MS;
    let outcome: { status: 'ended' | 'failed'; error: string | null } | null = null;
    if (!row.egressId) {
      if (old) outcome = { status: 'failed', error: 'start_timeout' };
    } else {
      let info: Awaited<ReturnType<StreamEgress['info']>>;
      try {
        info = await deps.egress.info(row.egressId);
      } catch {
        continue;
      }
      if (!info) {
        if (old) outcome = { status: 'failed', error: 'egress_lost' };
      } else if (info.state === 'failed') {
        outcome = { status: 'failed', error: (info.error ?? 'egress_failed').slice(0, 500) };
      } else if (info.state !== 'recording') {
        outcome = { status: 'ended', error: null };
      }
    }
    if (!outcome) continue;
    const result = await deps.sql`
      update live_streams set status = ${outcome.status}, error = ${outcome.error}, ended_at = now()
      where id = ${row.id} and status in ('starting', 'live')`;
    if (result.count === 0) continue;
    closed++;
    await endBroadcasts(deps, row.tenantId, row.targets);
    await publishRoomStateById(deps.sql, deps.lk, row.roomId);
  }
  return closed;
}

/** The room's last live, if it failed in the last ten minutes (to tell the moderator why). */
export async function recentLiveFailure(sql: Sql, room: Room): Promise<string | null> {
  const [row] = await sql<{ status: string; error: string | null; endedAt: Date | null }[]>`
    select status, error, ended_at as "endedAt" from live_streams
    where room_id = ${room.id} order by started_at desc limit 1`;
  const recent = row?.endedAt && Date.now() - new Date(row.endedAt).getTime() < 10 * 60_000;
  return row?.status === 'failed' && recent ? (row.error ?? 'failed') : null;
}
