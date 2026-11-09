import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import type { EgressResult, RecordingEgress } from '@/server/recordings/egress';
import {
  RECORDING_GRACE_MS,
  type RecordingDeps,
  activeRecording,
  deleteRecording,
  findVisibleRecording,
  listRecordings,
  recentFailure,
  settleRoom,
  startRecording,
  stopRecording,
} from '@/server/recordings/service';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';

class FakeLiveKit implements LiveKitAdmin {
  participants: LiveParticipant[] = [];
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
}

class FakeEgress implements RecordingEgress {
  started: { room: string; filepath: string }[] = [];
  stopped: string[] = [];
  states = new Map<string, EgressResult | null>();
  failStart = false;
  async start(room: string, filepath: string) {
    if (this.failStart) throw new Error('no egress worker');
    this.started.push({ room, filepath });
    return `EG_${this.started.length}`;
  }
  async stop(egressId: string) {
    this.stopped.push(egressId);
  }
  async info(egressId: string) {
    if (egressId === 'EG_boom') throw new Error('down');
    return this.states.get(egressId) ?? null;
  }
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

async function setup(plan: 'free' | 'enterprise' = 'enterprise') {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Admin', email: 'admin@acme.test', password: PASSWORD },
    null,
    plan,
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, 'bia@acme.test', 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  const room = await createRoom(db(), admin, createRoomInput.parse({ name: 'Vendas' }), null);
  const egress = new FakeEgress();
  const lk = new FakeLiveKit();
  const deps: RecordingDeps = { sql: db(), lk, egress, outputDir: '/out' };
  return { tenant, admin, member, room, egress, lk, deps };
}

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
});

describe('recordings', () => {
  it('records a room once at a time, then tracks it until the file is ready', async () => {
    const { tenant, admin, room, egress, deps } = await setup();
    const rec = await startRecording(deps, room, admin, '10.0.0.1');
    expect(rec).toMatchObject({ status: 'recording', roomName: 'Vendas', startedByName: 'Admin' });
    expect(rec.fileName).toBe(`${tenant.id}_${rec.id}.mp4`);
    expect(egress.started).toEqual([{ room: `${tenant.id}.${room.slug}`, filepath: `/out/${rec.fileName}` }]);
    await expectAppError(startRecording(deps, room, admin, null), 409);

    await stopRecording(deps, room, admin, null);
    expect(egress.stopped).toEqual(['EG_1']);
    expect(await activeRecording(db(), room)).toBeNull();
    await expectAppError(stopRecording(deps, room, admin, null), 404);

    egress.states.set('EG_1', { state: 'ready', sizeBytes: 5_000_000, durationS: 61, error: null });
    const [listed] = await listRecordings(deps, admin);
    expect(listed).toMatchObject({ id: rec.id, status: 'ready', sizeBytes: 5_000_000, durationS: 61 });
    expect(listed.endedAt).toBeInstanceOf(Date);

    const actions = await sql<{ action: string }[]>`select action from audit_log order by id`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['recording.started', 'recording.stopped']),
    );
  });

  it('only lets moderators record, and only on plans that include it', async () => {
    const { member, room, deps, lk } = await setup();
    await expectAppError(startRecording(deps, room, member, null), 403);
    await expectAppError(startRecording(deps, room, null, null), 403);
    lk.participants = [
      {
        identity: `u-${member.id}-abc`,
        name: 'Bia',
        role: 'moderator',
        isAgent: false,
        handRaised: false,
        audioTrackSids: [],
        audioMuted: true,
        joinedAt: 0,
      },
    ];
    expect((await startRecording(deps, room, member, null)).startedByName).toBe('Bia');

    await sql`truncate tenants, audit_log restart identity cascade`;
    const free = await setup('free');
    await expectAppError(startRecording(free.deps, free.room, free.admin, null), 403);
  });

  it('marks the recording failed when the recorder is unavailable', async () => {
    const { admin, room, egress, deps } = await setup();
    egress.failStart = true;
    await expectAppError(startRecording(deps, room, admin, null), 502);
    const [row] = await sql<{ status: string; error: string }[]>`select status, error from recordings`;
    expect(row).toEqual({ status: 'failed', error: 'start_failed' });
    egress.failStart = false;
    expect((await startRecording(deps, room, admin, null)).status).toBe('recording');
  });

  it('shows members only their own recordings and lets them delete finished ones', async () => {
    const { admin, member, room, egress, deps } = await setup();
    const rec = await startRecording(deps, room, admin, null);
    expect(await listRecordings(deps, member)).toEqual([]);
    await expectAppError(findVisibleRecording(db(), member, rec.id), 404);

    const removed: string[] = [];
    const remove = async (file: string) => {
      removed.push(file);
    };
    await expectAppError(deleteRecording(db(), admin, rec.id, remove, null), 409);
    await stopRecording(deps, room, admin, null);
    egress.states.set('EG_1', { state: 'failed', sizeBytes: null, durationS: null, error: 'boom' });
    expect((await listRecordings(deps, admin))[0]).toMatchObject({ status: 'failed', error: 'boom' });
    await deleteRecording(db(), admin, rec.id, remove, null);
    expect(removed).toEqual([rec.fileName]);
    expect(await listRecordings(deps, admin)).toEqual([]);
  });

  it('frees the room when Egress fails while opening its browser (issue #16)', async () => {
    const { admin, room, egress, deps } = await setup();
    const first = await startRecording(deps, room, admin, null);
    egress.states.set('EG_1', {
      state: 'failed',
      sizeBytes: null,
      durationS: null,
      error: 'page load error: websocket url timeout reached',
    });
    // The room shows "not recording" (LiveKit knows) and the server agrees right away.
    await settleRoom(deps, room);
    expect(await activeRecording(db(), room)).toBeNull();
    expect(await recentFailure(db(), room)).toMatchObject({
      id: first.id,
      status: 'failed',
      error: 'page load error: websocket url timeout reached',
    });
    await expectAppError(stopRecording(deps, room, admin, null), 404);

    const second = await startRecording(deps, room, admin, null);
    expect(second.status).toBe('recording');
    expect(egress.started).toHaveLength(2);
    expect(await recentFailure(db(), room)).toBeNull();
    const [old] = await sql<{ status: string; endedAt: Date | null }[]>`
      select status, ended_at as "endedAt" from recordings where id = ${first.id}`;
    expect(old.status).toBe('failed');
    expect(old.endedAt).toBeInstanceOf(Date);
  });

  it('times out orphans: unknown to Egress or never started, after a grace period', async () => {
    const { admin, room, deps } = await setup();
    const rec = await startRecording(deps, room, admin, null);
    // Egress does not know it (lost), but it just started: give it time.
    await settleRoom(deps, room);
    expect((await activeRecording(db(), room))?.id).toBe(rec.id);
    await settleRoom(deps, room, Date.now() + RECORDING_GRACE_MS + 1000);
    expect(await activeRecording(db(), room)).toBeNull();
    const [lost] = await sql<{ error: string }[]>`select error from recordings where id = ${rec.id}`;
    expect(lost.error).toBe('egress_lost');

    // A start that crashed before Egress answered (no Egress id), from long ago.
    await sql`insert into recordings (tenant_id, room_id, room_name, file_name, status, started_at)
              values (${admin.tenantId}, ${room.id}, 'Vendas', '', 'starting', now() - interval '10 minutes')`;
    expect((await activeRecording(db(), room))?.status).toBe('starting');
    expect((await startRecording(deps, room, admin, null)).status).toBe('recording');
    const errors = await sql<{ error: string | null }[]>`select error from recordings order by started_at`;
    expect(errors.map((e) => e.error)).toEqual(['start_timeout', 'egress_lost', null]);
  });

  it('leaves a recording alone while Egress cannot be reached (it may still be recording)', async () => {
    const { admin, room, deps } = await setup();
    const rec = await startRecording(deps, room, admin, null);
    await sql`update recordings set egress_id = 'EG_boom', started_at = now() - interval '1 hour'
              where id = ${rec.id}`;
    await settleRoom(deps, room);
    expect((await activeRecording(db(), room))?.id).toBe(rec.id);
    await expectAppError(startRecording(deps, room, admin, null), 409);
  });

  it('never runs two recordings of one room, even when asked at the same time', async () => {
    const { admin, room, egress, deps } = await setup();
    const results = await Promise.allSettled([
      startRecording(deps, room, admin, null),
      startRecording(deps, room, admin, null),
      startRecording(deps, room, admin, null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect(((r as PromiseRejectedResult).reason as AppError).status).toBe(409);
    expect(egress.started).toHaveLength(1);
  });

  it('keeps a finished recording ready and downloadable', async () => {
    const { admin, room, egress, deps } = await setup();
    const rec = await startRecording(deps, room, admin, null);
    await stopRecording(deps, room, admin, null);
    egress.states.set('EG_1', { state: 'ready', sizeBytes: 10, durationS: 3, error: null });
    await listRecordings(deps, admin);
    egress.states.delete('EG_1'); // Egress forgets finished jobs after a while
    await settleRoom(deps, room, Date.now() + RECORDING_GRACE_MS * 10);
    expect(await findVisibleRecording(db(), admin, rec.id)).toMatchObject({ status: 'ready', error: null });
  });

  it('keeps listing when Egress cannot be reached', async () => {
    const { admin, room, deps } = await setup();
    const rec = await startRecording(deps, room, admin, null);
    await sql`update recordings set egress_id = 'EG_boom' where id = ${rec.id}`;
    await sql`insert into recordings (tenant_id, room_name, file_name, status)
              values (${admin.tenantId}, 'x', '', 'starting')`;
    const list = await listRecordings(deps, admin);
    expect(list.map((r) => r.status).sort()).toEqual(['recording', 'starting']);
  });
});
