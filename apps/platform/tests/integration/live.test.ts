import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import {
  type LiveDeps,
  addRtmp,
  assertPublicRtmpUrl,
  finishYoutube,
  listDestinations,
  removeDestination,
  roomLive,
  settleLives,
  startLive,
  startYoutube,
  stopLive,
} from '@/server/live/service';
import type { EgressResult, StreamEgress } from '@/server/recordings/egress';
import { roomStateOf } from '@/server/room-state';
import { type Room, createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import type { Fetch } from '@/server/storage/google';
import { oauthPurpose, savePlatformGoogle } from '@/server/storage/service';
import {
  createRoomInput,
  liveStartInput,
  platformGoogleInput,
  rtmpDestinationInput,
  youtubeStartInput,
} from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';
const YT = 'https://www.googleapis.com/youtube/v3';

class FakeLiveKit implements LiveKitAdmin {
  participants: LiveParticipant[] = [];
  metadata: string[] = [];
  async listParticipants() {
    return this.participants;
  }
  async listRooms() {
    return [];
  }
  async muteTrack() {}
  async remove() {}
  async setRole() {}
  async setAttributes() {}
  async dispatchAgent() {}
  async sendData() {}
  async updateRoomMetadata(_room: string, metadata: string) {
    this.metadata.push(metadata);
  }
}

class FakeEgress implements StreamEgress {
  streams: { room: string; urls: string[]; layoutUrl?: string }[] = [];
  stopped: string[] = [];
  states = new Map<string, EgressResult | null>();
  fail = false;
  async stream(room: string, urls: string[], layoutUrl?: string) {
    if (this.fail) throw new Error('no egress worker');
    this.streams.push({ room, urls, ...(layoutUrl ? { layoutUrl } : {}) });
    return `EG_${this.streams.length}`;
  }
  async stop(egressId: string) {
    this.stopped.push(egressId);
  }
  async info(egressId: string) {
    if (egressId === 'EG_boom') throw new Error('down');
    return this.states.has(egressId) ? (this.states.get(egressId) ?? null) : running;
  }
}

const running: EgressResult = { state: 'recording', sizeBytes: null, durationS: null, error: null };

/** Google's token endpoints and the YouTube Live calls, as far as these flows use them. */
function fakeGoogle(
  opts: {
    scope?: string;
    channel?: boolean;
    notEnabled?: boolean;
    lifecycle?: string;
    failStream?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'lives@acme.com', email_verified: true })).toString('base64url')}.y`;
  const fn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(YT, '').split('&')[0]}`);
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code')
        return Response.json({
          refresh_token: 'yt-refresh-0123456789',
          access_token: 'access-1',
          id_token: idToken,
          scope: opts.scope ?? 'openid https://www.googleapis.com/auth/youtube',
        });
      return Response.json({ access_token: 'access-2' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('{}');
    if (url.startsWith(`${YT}/channels`))
      return Response.json({
        items: opts.channel === false ? [] : [{ id: 'UC1', snippet: { title: 'Canal Acme' } }],
      });
    if (url.startsWith(`${YT}/liveBroadcasts/bind`)) return Response.json({ id: 'B1' });
    if (url.startsWith(`${YT}/liveBroadcasts/transition`)) return Response.json({ id: 'B1' });
    if (url.startsWith(`${YT}/liveBroadcasts?part=status`))
      return Response.json({ items: [{ status: { lifeCycleStatus: opts.lifecycle ?? 'live' } }] });
    if (url.startsWith(`${YT}/liveBroadcasts?id=`) && method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.startsWith(`${YT}/liveBroadcasts?`) && method === 'POST') {
      if (opts.notEnabled)
        return Response.json(
          { error: { message: 'no', errors: [{ reason: 'liveStreamingNotEnabled' }] } },
          { status: 403 },
        );
      const body = JSON.parse(String(init?.body)) as {
        snippet: { title: string };
        status: { privacyStatus: string };
      };
      calls.push(`broadcast ${body.snippet.title} ${body.status.privacyStatus}`);
      return Response.json({ id: 'B1' });
    }
    if (url.startsWith(`${YT}/liveStreams?`)) {
      if (opts.failStream) return Response.json({ error: { message: 'boom' } }, { status: 500 });
      return Response.json({
        id: 'S1',
        cdn: {
          ingestionInfo: {
            ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
            rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2/',
            streamName: 'abcd-1234',
          },
        },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as Fetch;
  return { fn, calls };
}

interface World {
  tenantId: string;
  admin: SessionUser;
  member: SessionUser;
  root: SessionUser;
  room: Room;
  studio: Room;
  lk: FakeLiveKit;
  egress: FakeEgress;
  google: ReturnType<typeof fakeGoogle>;
  deps: LiveDeps;
}

async function world(google = fakeGoogle()): Promise<World> {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Admin', email: 'admin@acme.test', password: PASSWORD },
    null,
    'enterprise',
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  const room = await createRoom(db(), admin, createRoomInput.parse({ name: 'Vendas' }), null);
  const studio = await createRoom(db(), admin, createRoomInput.parse({ name: 'Show', studio: true }), null);
  const lk = new FakeLiveKit();
  const egress = new FakeEgress();
  const deps: LiveDeps = {
    sql: db(),
    key: READY_AGENT_KEY,
    recordingsDir: null,
    platformUrl: 'https://meet.example.com',
    resolve: async () => ['93.184.215.14'],
    fetch: google.fn,
    lk,
    egress,
    studioUrl: 'https://meet.example.com/studio/render',
  };
  const root = { ...admin, isSuperadmin: true };
  await savePlatformGoogle(
    deps,
    root,
    platformGoogleInput.parse({
      clientId: '123456789012-abcdefghij0123456789.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret_0123456789',
    }),
    null,
  );
  return { tenantId: tenant.id, admin, member, root, room, studio, lk, egress, google, deps };
}

async function expectAppError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
  if (message) expect((err as AppError).message).toMatch(message);
}

const rtmp = (over: Record<string, unknown> = {}) =>
  rtmpDestinationInput.parse({
    name: 'Twitch',
    url: 'rtmp://live.twitch.tv/app/',
    streamKey: 'live_123_SECRETkey',
    ...over,
  });

/** Connects a YouTube channel the way the browser does: start, consent, callback. */
async function connectYoutube(w: World, google = w.google): Promise<string> {
  const deps = { ...w.deps, fetch: google.fn };
  const { url } = await startYoutube(
    deps,
    w.admin,
    youtubeStartInput.parse({ name: '' }),
    'https://acme.example/admin?tab=streaming',
  );
  const state = new URL(url).searchParams.get('state');
  expect(new URL(url).searchParams.get('scope')).toContain('https://www.googleapis.com/auth/youtube');
  expect(await oauthPurpose(db(), state)).toBe('youtube');
  return finishYoutube(deps, { state, code: 'code-1', error: null }, '10.0.0.1');
}

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log, platform_google restart identity cascade`;
});

describe('live destinations', () => {
  it('keeps RTMP keys sealed, shows only their end, and only admins manage them', async () => {
    const w = await world();
    const view = await addRtmp(w.deps, w.admin, rtmp(), '10.0.0.1');
    expect(view).toMatchObject({ encryption: true, googleAvailable: true, streaming: true });
    expect(view.destinations).toEqual([
      expect.objectContaining({
        kind: 'rtmp',
        name: 'Twitch',
        rtmpUrl: 'rtmp://live.twitch.tv/app',
        secretHint: '••••Tkey',
      }),
    ]);
    expect(JSON.stringify(view)).not.toContain('SECRET');
    const [row] = await sql<{ secret_sealed: string }[]>`select secret_sealed from stream_destinations`;
    expect(row.secret_sealed).not.toContain('SECRET');
    await expectAppError(addRtmp(w.deps, w.member, rtmp(), null), 403);
    await expectAppError(listDestinations(w.deps, w.member), 403);

    const [audit] = await sql<{ meta: Record<string, unknown> }[]>`
      select meta from audit_log where action = 'live.destination_added'`;
    expect(audit.meta).toEqual({ kind: 'rtmp', host: 'live.twitch.tv' });

    const id = view.destinations[0].id;
    await expectAppError(removeDestination(w.deps, w.member, id, null), 403);
    expect((await removeDestination(w.deps, w.admin, id, null)).destinations).toEqual([]);
    await expectAppError(removeDestination(w.deps, w.admin, id, null), 404);
  });

  it('accepts only public rtmp(s) servers, and up to ten destinations', async () => {
    const w = await world();
    const resolve = async (host: string) => (host === 'intranet.test' ? ['10.0.0.5'] : ['93.184.215.14']);
    await expect(assertPublicRtmpUrl('rtmps://a.rtmps.youtube.com/live2/', resolve)).resolves.toBe(
      'rtmps://a.rtmps.youtube.com/live2',
    );
    for (const [url, message] of [
      ['not a url', /inválido/],
      ['https://x.test/live', /rtmp/],
      ['rtmp://user:pw@x.test/live', /usuário/],
      ['rtmp://intranet.test/live', /público/],
      ['rtmp://127.0.0.1/live', /público/],
    ] as const)
      await expectAppError(assertPublicRtmpUrl(url, resolve), 400, message);
    expect(
      rtmpDestinationInput.safeParse({ name: 'x', url: 'rtmp://a', streamKey: 'with space' }).success,
    ).toBe(false);

    for (let i = 0; i < 10; i++) await addRtmp(w.deps, w.admin, rtmp({ name: `D${i}` }), null);
    await expectAppError(addRtmp(w.deps, w.admin, rtmp(), null), 400, /10 destinos/);
    await expectAppError(
      startYoutube(w.deps, w.admin, youtubeStartInput.parse({}), 'https://acme.example/admin'),
      400,
      /10 destinos/,
    );
  });

  it('connects a YouTube channel through Google, once per consent', async () => {
    const w = await world();
    expect(await connectYoutube(w)).toBe('https://acme.example/admin?tab=streaming&youtube=connected');
    const [dest] = (await listDestinations(w.deps, w.admin)).destinations;
    expect(dest).toMatchObject({
      kind: 'youtube',
      name: 'YouTube · Canal Acme',
      googleEmail: 'lives@acme.com',
      channelTitle: 'Canal Acme',
    });
    const [row] = await sql<{ secret_sealed: string }[]>`select secret_sealed from stream_destinations`;
    expect(row.secret_sealed).not.toContain('yt-refresh');

    // Each consent is used once; a stale or unknown one is refused.
    await expectAppError(finishYoutube(w.deps, { state: 'nope', code: 'c', error: null }, null), 400);
    await expectAppError(finishYoutube(w.deps, { state: null, code: 'c', error: null }, null), 400);
    expect(await oauthPurpose(db(), 'nope')).toBeNull();
    expect(await oauthPurpose(db(), null)).toBeNull();

    // Removing it revokes the access at Google.
    await removeDestination(w.deps, w.admin, dest.id, null);
    expect(w.google.calls).toContain('POST https://oauth2.googleapis.com/revoke');
    await expectAppError(
      startYoutube(w.deps, w.member, youtubeStartInput.parse({}), 'https://acme.example/admin'),
      403,
    );
  });

  it('tells the admin when Google gave no YouTube permission, no channel, or was cancelled', async () => {
    const w = await world();
    expect(await connectYoutube(w, fakeGoogle({ scope: 'openid email' }))).toContain('youtube=scope');
    expect(await connectYoutube(w, fakeGoogle({ channel: false }))).toContain('youtube=nochannel');
    const { url } = await startYoutube(
      w.deps,
      w.admin,
      youtubeStartInput.parse({ name: 'Canal' }),
      'https://a.example/x',
    );
    const state = new URL(url).searchParams.get('state');
    expect(await finishYoutube(w.deps, { state, code: null, error: 'access_denied' }, null)).toContain(
      'youtube=cancelled',
    );
    expect((await listDestinations(w.deps, w.admin)).destinations).toEqual([]);
  });
});

describe('going live', () => {
  it('streams a meeting to RTMP and a studio to YouTube, tells the room, and ends both', async () => {
    const w = await world();
    const { destinations } = await addRtmp(w.deps, w.admin, rtmp(), null);
    await connectYoutube(w);
    const all = (await listDestinations(w.deps, w.admin)).destinations;
    const twitch = destinations[0].id;
    const youtube = all.find((d) => d.kind === 'youtube')!.id;

    // A meeting goes out as the grid, with the key appended to the server address.
    expect(await roomLive(w.deps, w.room, w.admin)).toMatchObject({
      canLive: true,
      active: null,
      failure: null,
    });
    const meetingLive = await startLive(
      w.deps,
      w.room,
      w.admin,
      liveStartInput.parse({ destinationIds: [twitch], title: 'Reunião aberta' }),
      null,
    );
    expect(meetingLive).toMatchObject({ status: 'live', title: 'Reunião aberta', startedByName: 'Admin' });
    expect(w.egress.streams[0]).toEqual({
      room: `${w.tenantId}.${w.room.slug}`,
      urls: ['rtmp://live.twitch.tv/app/live_123_SECRETkey'],
    });
    await expectAppError(
      startLive(
        w.deps,
        w.room,
        w.admin,
        liveStartInput.parse({ destinationIds: [twitch], title: 'x' }),
        null,
      ),
      409,
    );

    // A studio goes out through its stage page; YouTube gets a new broadcast, unlisted.
    await expectAppError(
      startLive(
        w.deps,
        w.studio,
        w.admin,
        liveStartInput.parse({ destinationIds: [youtube], title: 'Show' }),
        null,
      ),
      400,
      /quem pode ver/,
    );
    const show = await startLive(
      w.deps,
      w.studio,
      w.admin,
      liveStartInput.parse({
        destinationIds: [youtube, twitch],
        title: 'Show ao vivo',
        description: 'Episódio 1',
        privacy: 'unlisted',
      }),
      '10.0.0.1',
    );
    expect(w.google.calls).toContain('broadcast Show ao vivo unlisted');
    expect(w.egress.streams[1]).toEqual({
      room: `${w.tenantId}.${w.studio.slug}`,
      urls: ['rtmps://a.rtmps.youtube.com/live2/abcd-1234', 'rtmp://live.twitch.tv/app/live_123_SECRETkey'],
      layoutUrl: 'https://meet.example.com/studio/render',
    });
    expect(show.targets).toEqual([
      {
        destinationId: youtube,
        kind: 'youtube',
        name: 'YouTube · Canal Acme',
        watchUrl: 'https://www.youtube.com/watch?v=B1',
      },
      { destinationId: twitch, kind: 'rtmp', name: 'Twitch' },
    ]);
    // Everyone in the room learns it is live (and where to), never the keys.
    const state = JSON.parse(w.lk.metadata.at(-1)!) as { live: { to: string[] }; studio: unknown };
    expect(state.live.to).toEqual(['YouTube · Canal Acme', 'Twitch']);
    expect(state.studio).not.toBeNull();
    expect(w.lk.metadata.join()).not.toContain('SECRET');
    const [stored] = await sql<
      { targets: unknown }[]
    >`select targets from live_streams where egress_id = 'EG_2'`;
    expect(JSON.stringify(stored.targets)).not.toContain('abcd-1234');

    // Only moderators with an account; members see it is live but cannot touch it.
    expect(await roomLive(w.deps, w.studio, w.member)).toMatchObject({ canLive: false, destinations: [] });
    await expectAppError(stopLive(w.deps, w.studio, w.member, null), 403);
    await expectAppError(stopLive(w.deps, w.studio, null, null), 403);

    await stopLive(w.deps, w.studio, w.admin, null);
    expect(w.egress.stopped).toEqual(['EG_2']);
    expect(w.google.calls).toContain('POST /liveBroadcasts/transition?part=id');
    expect((await roomStateOf(db(), w.studio)).live).toBeNull();
    await expectAppError(stopLive(w.deps, w.studio, w.admin, null), 404);

    const actions = await sql<{ action: string; meta: Record<string, unknown> | null }[]>`
      select action, meta from audit_log where action like 'live.%' and action not like 'live.destination%' order by id`;
    expect(actions.map((a) => a.action)).toEqual(['live.started', 'live.started', 'live.stopped']);
    expect(actions[1].meta).toEqual({ to: 'YouTube · Canal Acme, Twitch' });
  });

  it('closes a live the recorder dropped, ends its YouTube broadcast and says why', async () => {
    const w = await world(fakeGoogle({ lifecycle: 'ready' }));
    await connectYoutube(w);
    const [yt] = (await listDestinations(w.deps, w.admin)).destinations;
    const input = liveStartInput.parse({ destinationIds: [yt.id], title: 'Live', privacy: 'public' });
    await startLive(w.deps, w.room, w.admin, input, null);

    // Egress unreachable: nothing changes (it may still be streaming).
    await sql`update live_streams set egress_id = 'EG_boom'`;
    expect(await settleLives(w.deps)).toBe(0);
    await sql`update live_streams set egress_id = 'EG_1'`;

    w.egress.states.set('EG_1', {
      state: 'failed',
      sizeBytes: null,
      durationS: null,
      error: 'rtmp connection refused',
    });
    expect(await settleLives(w.deps)).toBe(1);
    // Never aired: the empty broadcast is deleted on YouTube.
    expect(w.google.calls).toContain('DELETE /liveBroadcasts?id=B1');
    expect(await roomLive(w.deps, w.room, w.admin)).toMatchObject({
      active: null,
      failure: 'rtmp connection refused',
    });
    expect(JSON.parse(w.lk.metadata.at(-1)!)).toMatchObject({ live: null });

    // A stream that finished normally, or one Egress forgot long ago.
    await startLive(w.deps, w.room, w.admin, input, null);
    w.egress.states.set('EG_2', { state: 'ready', sizeBytes: null, durationS: null, error: null });
    expect(await settleLives(w.deps, w.room.id)).toBe(1);
    expect((await roomLive(w.deps, w.room, w.admin)).failure).toBeNull();

    await startLive(w.deps, w.room, w.admin, input, null);
    w.egress.states.set('EG_3', null);
    expect(await settleLives(w.deps)).toBe(0);
    expect(await settleLives(w.deps, undefined, Date.now() + 3 * 60_000)).toBe(1);

    // Never given an Egress id (the server died while starting): failed after the grace time.
    await sql`
      insert into live_streams (tenant_id, room_id, status, title)
      values (${w.tenantId}, ${w.room.id}, 'starting', 'x')`;
    expect(await settleLives(w.deps, w.room.id, Date.now() + 3 * 60_000)).toBe(1);
    expect(await settleLives({ ...w.deps, egress: null })).toBe(0);
  });

  it('cleans up when YouTube or the recorder refuses, and checks every rule first', async () => {
    const w = await world(fakeGoogle({ notEnabled: true }));
    await connectYoutube(w);
    const [yt] = (await listDestinations(w.deps, w.admin)).destinations;
    const input = liveStartInput.parse({ destinationIds: [yt.id], title: 'Live', privacy: 'private' });
    await expectAppError(startLive(w.deps, w.room, w.admin, input, null), 400, /YouTube Studio/);
    expect(await roomLive(w.deps, w.room, w.admin)).toMatchObject({
      active: null,
      failure: expect.stringContaining('YouTube Studio'),
    });

    // The stream half fails: the broadcast already created is removed.
    const half = fakeGoogle({ failStream: true, lifecycle: 'created' });
    await expectAppError(
      startLive({ ...w.deps, fetch: half.fn }, w.room, w.admin, input, null),
      400,
      /envio da live/,
    );
    expect(half.calls).toContain('DELETE /liveBroadcasts?id=B1');

    // The recorder is down: the YouTube broadcast is ended and the live marked failed.
    const ok = fakeGoogle({ lifecycle: 'ready' });
    w.egress.fail = true;
    await expectAppError(startLive({ ...w.deps, fetch: ok.fn }, w.room, w.admin, input, null), 502);
    expect(ok.calls).toContain('DELETE /liveBroadcasts?id=B1');
    w.egress.fail = false;

    await expectAppError(
      startLive(
        w.deps,
        w.room,
        w.admin,
        liveStartInput.parse({ destinationIds: [crypto.randomUUID()], title: 'x' }),
        null,
      ),
      404,
    );
    await expectAppError(startLive(w.deps, w.room, w.member, input, null), 403);
    await expectAppError(startLive({ ...w.deps, egress: null }, w.room, w.admin, input, null), 501);
    expect(await roomLive({ ...w.deps, egress: null }, w.room, w.admin)).toMatchObject({ canLive: false });
    await sql`update tenants set limits = '{"recording": false}' where id = ${w.tenantId}`;
    await expectAppError(startLive(w.deps, w.room, w.admin, input, null), 403, /plano/);
    expect(await roomLive(w.deps, w.room, w.admin)).toMatchObject({ canLive: false });

    expect(liveStartInput.safeParse({ destinationIds: [], title: 'x' }).success).toBe(false);
    expect(liveStartInput.safeParse({ destinationIds: [yt.id], title: '<b>' }).success).toBe(false);
    expect(liveStartInput.safeParse({ destinationIds: [yt.id], title: '   ' }).success).toBe(false);
  });
});
