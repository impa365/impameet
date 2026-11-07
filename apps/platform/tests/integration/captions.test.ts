import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import { defaultAgentId, listAgents, updateAgent } from '@/server/agents/service';
import { captionsOn, startCaptions, stopCaptions } from '@/server/captions/service';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import { createRoom, updateRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import {
  deleteTranscript,
  formatTranscript,
  listTranscripts,
  saveTranscript,
  transcriptInput,
  transcriptText,
} from '@/server/transcripts/service';
import { agentInput, createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';

class FakeLiveKit implements LiveKitAdmin {
  participants: LiveParticipant[] = [];
  calls: string[] = [];
  async listParticipants() {
    return this.participants;
  }
  async listRooms() {
    return [];
  }
  async muteAudio() {}
  async remove(room: string, identity: string) {
    this.calls.push(`remove ${room} ${identity}`);
    this.participants = this.participants.filter((p) => p.identity !== identity);
  }
  async setRole() {}
  async dispatchAgent(room: string, agentName: string, metadata: string) {
    this.calls.push(`dispatch ${room} ${agentName} ${metadata}`);
    this.participants.push({
      identity: 'agent-cc',
      name: 'Legendas',
      role: 'participant',
      isAgent: true,
      mode: 'captions',
      handRaised: false,
      audioTrackSids: [],
      audioMuted: true,
      joinedAt: 0,
    });
  }
  async sendData() {}
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

async function setup(plan: 'free' | 'enterprise' = 'enterprise', slug = 'acme') {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: slug, slug, name: 'Admin', email: `admin@${slug}.test`, password: PASSWORD },
    null,
    plan,
  );
  const [member] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenant.id}, ${`bia@${slug}.test`}, 'Bia', ${await hashPassword(PASSWORD)}, 'member')
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  // Transcription uses the room agent's own Fish Audio account and model.
  let agentIds: string[] = [];
  if (plan !== 'free') {
    const [kaiser] = await listAgents(db(), admin);
    const choices = await agentChoices(db(), admin);
    await updateAgent(
      db(),
      admin,
      kaiser.id,
      agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices }),
      null,
    );
    agentIds = [kaiser.id];
  }
  const room = await createRoom(
    db(),
    member,
    createRoomInput.parse({ name: 'Reunião de Vendas', agentIds }),
    null,
  );
  return { tenant, admin, member, room, lk: new FakeLiveKit() };
}

const payload = (room: string, lines = 2) =>
  transcriptInput.parse({
    room,
    startedAt: 1_790_000_000,
    endedAt: 1_790_000_600,
    lines: Array.from({ length: lines }, (_, i) => ({
      at: i * 65.4,
      identity: `u-${i}`,
      name: i % 2 ? 'Kaiser' : 'Bia',
      text: `fala ${i}`,
    })),
  });

beforeAll(async () => {
  sql = await freshDatabase();
});
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
});

describe('live captions', () => {
  it('lets the room owner start and stop the captions worker', async () => {
    const { tenant, member, room, lk } = await setup();
    expect(await captionsOn(lk, room)).toBe(false);
    await startCaptions(db(), lk, 'kaiser', room, member, null);
    const agentId = await defaultAgentId(db(), tenant.id);
    expect(lk.calls[0]).toBe(
      `dispatch ${tenant.id}.${room.slug} kaiser {"mode":"captions","agentId":"${agentId}"}`,
    );
    expect(await captionsOn(lk, room)).toBe(true);
    await expectAppError(startCaptions(db(), lk, 'kaiser', room, member, null), 409);

    await stopCaptions(db(), lk, room, member, null);
    expect(lk.calls[1]).toBe(`remove ${tenant.id}.${room.slug} agent-cc`);
    await expectAppError(stopCaptions(db(), lk, room, member, null), 404);
  });

  it('needs a configured agent in the room (no server Fish account)', async () => {
    const { member, room, lk } = await setup();
    const bare = await updateRoom(db(), member, room.slug, { agentIds: [] }, null);
    await expectAppError(startCaptions(db(), lk, 'kaiser', bare, member, null), 400);
  });

  it('refuses people who cannot moderate and plans without AI', async () => {
    const { admin, room, lk } = await setup();
    const [other] = await sql<SessionUser[]>`
      insert into users (tenant_id, email, name, password_hash, role)
      values (${admin.tenantId}, 'caio@acme.test', 'Caio', ${await hashPassword(PASSWORD)}, 'member')
      returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
    await expectAppError(startCaptions(db(), lk, 'kaiser', room, other, null), 403);
    await expectAppError(startCaptions(db(), lk, 'kaiser', room, null, null), 403);
    await startCaptions(db(), lk, 'kaiser', room, admin, null);

    await sql`truncate tenants, audit_log restart identity cascade`;
    const free = await setup('free');
    await expectAppError(startCaptions(db(), free.lk, 'kaiser', free.room, free.admin, null), 403);
  });
});

describe('transcripts', () => {
  it('saves what the worker sends, credits who started it and lists it to the right people', async () => {
    const { tenant, admin, member, room, lk } = await setup();
    await startCaptions(db(), lk, 'kaiser', room, member, null);
    const id = await saveTranscript(db(), payload(`${tenant.id}.${room.slug}`));

    const [mine] = await listTranscripts(db(), member);
    expect(mine).toMatchObject({ id, roomName: 'Reunião de Vendas', startedByName: 'Bia', lineCount: 2 });
    expect((await listTranscripts(db(), admin)).map((t) => t.id)).toEqual([id]);
    const [sessions] = await sql<{ n: number }[]>`select count(*)::int as n from caption_sessions`;
    expect(sessions.n).toBe(0);

    const { text } = await transcriptText(db(), member, id);
    expect(text).toContain('Transcrição — Reunião de Vendas');
    expect(text).toContain('[00:00:00] Bia: fala 0');
    expect(text).toContain('[00:01:05] Kaiser: fala 1');
  });

  it('hides transcripts from other members and organizations', async () => {
    const { tenant, admin, room } = await setup();
    const id = await saveTranscript(db(), payload(`${tenant.id}.${room.slug}`));
    const [caio] = await sql<SessionUser[]>`
      insert into users (tenant_id, email, name, password_hash, role)
      values (${admin.tenantId}, 'caio@acme.test', 'Caio', ${await hashPassword(PASSWORD)}, 'member')
      returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
    expect(await listTranscripts(db(), caio)).toEqual([]);
    await expectAppError(transcriptText(db(), caio, id), 404);

    const rival = await setup('enterprise', 'rival');
    expect(await listTranscripts(db(), rival.admin)).toEqual([]);
    await expectAppError(transcriptText(db(), rival.admin, id), 404);
  });

  it('rejects transcripts for unknown rooms and lets owners and admins delete', async () => {
    const { tenant, admin, member, room } = await setup();
    await expectAppError(saveTranscript(db(), payload(`${tenant.id}.nao-existe`)), 404);
    const id = await saveTranscript(db(), payload(`${tenant.id}.${room.slug}`));
    // The room owner may read it but only who started captions (or an admin) may delete.
    await expectAppError(deleteTranscript(db(), member, id, null), 403);
    await deleteTranscript(db(), admin, id, null);
    expect(await listTranscripts(db(), admin)).toEqual([]);
  });

  it('validates worker payloads', () => {
    expect(() => transcriptInput.parse({ ...payload('x.y'), room: '../x' })).toThrow();
    expect(() =>
      transcriptInput.parse({ ...payload('11111111-1111-4111-8111-111111111111.sala'), lines: [] }),
    ).toThrow();
    expect(
      formatTranscript('Sala', new Date(0), [{ at: 3725, identity: 'a', name: 'Ana', text: 'oi' }]),
    ).toContain('[01:02:05] Ana: oi');
  });
});
