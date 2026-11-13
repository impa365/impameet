/**
 * The YouTube Live calls a broadcast needs, over plain fetch: the channel behind a connected
 * account, then per live a broadcast (what viewers see) bound to a stream (where we send the
 * video). The broadcast starts and stops on its own with the video.
 */
import type { Fetch } from '../storage/google';
import { GoogleError } from '../storage/google';

const API = 'https://www.googleapis.com/youtube/v3';
const TIMEOUT_MS = 20_000;
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
export const YOUTUBE_SCOPES = ['openid', 'email', YOUTUBE_SCOPE];

export type YoutubePrivacy = 'public' | 'unlisted' | 'private';

/** What the person can act on, in Portuguese, for YouTube's reasons. */
const REASONS: Record<string, string> = {
  liveStreamingNotEnabled:
    'Este canal ainda não pode fazer lives: ative em YouTube Studio > Criar > Transmitir ao vivo (na primeira vez o YouTube pode levar até 24 horas)',
  livePermissionBlocked: 'O YouTube bloqueou as lives deste canal',
  insufficientPermissions: 'A conta conectada não tem permissão para fazer lives neste canal',
  quotaExceeded: 'A cota diária da API do YouTube acabou; tente amanhã ou peça mais cota no Google Cloud',
  rateLimitExceeded: 'O YouTube pediu para esperar um pouco; tente de novo em instantes',
  invalidDescription: 'A descrição não foi aceita pelo YouTube',
  invalidTitle: 'O título não foi aceito pelo YouTube',
  titleRequired: 'Informe o título da live',
};

async function call(
  fetchImpl: Fetch,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new GoogleError('Não foi possível falar com o YouTube agora');
  }
}

async function failure(res: Response, what: string): Promise<GoogleError> {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? '';
  const known = REASONS[reason];
  const detail = known ?? `${what}: ${String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`;
  return new GoogleError(detail, res.status);
}

/** The channel of the connected account (the one lives go to). */
export async function myChannel(fetchImpl: Fetch, token: string): Promise<{ id: string; title: string }> {
  const res = await call(fetchImpl, token, '/channels?part=snippet&mine=true');
  if (!res.ok) throw await failure(res, 'O YouTube recusou ler o canal');
  const body = (await res.json()) as { items?: { id?: string; snippet?: { title?: string } }[] };
  const channel = body.items?.[0];
  if (!channel?.id) throw new GoogleError('Esta conta Google não tem um canal do YouTube');
  return { id: channel.id, title: channel.snippet?.title ?? '' };
}

export interface YoutubeLive {
  broadcastId: string;
  watchUrl: string;
  /** rtmps when YouTube offers it (the key travels encrypted), with the stream key. */
  ingestUrl: string;
}

/** A broadcast, starting now, that goes live on its own when the video arrives. */
export async function createLive(
  fetchImpl: Fetch,
  token: string,
  input: { title: string; description: string; privacy: YoutubePrivacy },
): Promise<YoutubeLive> {
  const broadcastRes = await call(fetchImpl, token, '/liveBroadcasts?part=id,snippet,status,contentDetails', {
    method: 'POST',
    body: JSON.stringify({
      snippet: {
        title: input.title,
        description: input.description,
        scheduledStartTime: new Date().toISOString(),
      },
      status: { privacyStatus: input.privacy },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true },
    }),
  });
  if (!broadcastRes.ok) throw await failure(broadcastRes, 'O YouTube recusou criar a live');
  const broadcast = (await broadcastRes.json()) as { id?: string };
  if (!broadcast.id) throw new GoogleError('O YouTube não devolveu a live');
  try {
    const streamRes = await call(fetchImpl, token, '/liveStreams?part=id,snippet,cdn,contentDetails', {
      method: 'POST',
      body: JSON.stringify({
        snippet: { title: input.title },
        cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
        contentDetails: { isReusable: false },
      }),
    });
    if (!streamRes.ok) throw await failure(streamRes, 'O YouTube recusou criar o envio da live');
    const stream = (await streamRes.json()) as {
      id?: string;
      cdn?: {
        ingestionInfo?: { ingestionAddress?: string; rtmpsIngestionAddress?: string; streamName?: string };
      };
    };
    const ingest = stream.cdn?.ingestionInfo;
    const address = ingest?.rtmpsIngestionAddress || ingest?.ingestionAddress;
    if (!stream.id || !address || !ingest?.streamName)
      throw new GoogleError('O YouTube não devolveu o envio da live');
    const bindRes = await call(
      fetchImpl,
      token,
      `/liveBroadcasts/bind?part=id&id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}`,
      { method: 'POST' },
    );
    if (!bindRes.ok) throw await failure(bindRes, 'O YouTube recusou ligar a live ao envio');
    return {
      broadcastId: broadcast.id,
      watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(broadcast.id)}`,
      ingestUrl: `${address.replace(/\/+$/, '')}/${ingest.streamName}`,
    };
  } catch (err) {
    await deleteLive(fetchImpl, token, broadcast.id);
    throw err;
  }
}

/** Broadcasts that never went on air: deleting them leaves no empty "upcoming" live behind. */
const NEVER_AIRED = new Set(['created', 'ready']);
const ON_AIR = new Set(['live', 'liveStarting', 'testing', 'testStarting']);

/**
 * Ends a broadcast that is on air; one that never went on air is deleted. A finished one (YouTube
 * stops it on its own when the video ends) is left alone: it is the channel's video now.
 */
export async function endLive(fetchImpl: Fetch, token: string, broadcastId: string): Promise<void> {
  const id = encodeURIComponent(broadcastId);
  const res = await call(fetchImpl, token, `/liveBroadcasts?part=status&id=${id}`).catch(() => null);
  if (!res?.ok) return;
  const body = (await res.json().catch(() => null)) as {
    items?: { status?: { lifeCycleStatus?: string } }[];
  } | null;
  const status = body?.items?.[0]?.status?.lifeCycleStatus ?? '';
  if (ON_AIR.has(status)) {
    await call(fetchImpl, token, `/liveBroadcasts/transition?part=id&broadcastStatus=complete&id=${id}`, {
      method: 'POST',
    }).catch(() => undefined);
  } else if (NEVER_AIRED.has(status)) {
    await deleteLive(fetchImpl, token, broadcastId);
  }
}

async function deleteLive(fetchImpl: Fetch, token: string, broadcastId: string): Promise<void> {
  await call(fetchImpl, token, `/liveBroadcasts?id=${encodeURIComponent(broadcastId)}`, {
    method: 'DELETE',
  }).catch(() => undefined);
}
