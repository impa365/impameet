import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, defaultAgentId, listAgents, updateAgent } from '@/server/agents/service';
import { isVoiceAgent, syncLiveAgents } from '@/server/agents/live';
import { signup } from '@/server/auth/service';
import type { Sql } from '@/server/db';
import type { LiveKitAdmin, LiveParticipant } from '@/server/livekit-admin';
import { createRoom, updateRoom } from '@/server/rooms/service';
import { agentInput, createRoomInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;

const person = (identity: string, extra: Partial<LiveParticipant> = {}): LiveParticipant => ({
  identity,
  name: identity,
  role: 'participant',
  isAgent: false,
  handRaised: false,
  audioTrackSids: [],
  audioMuted: true,
  joinedAt: 0,
  ...extra,
});

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
  async remove(_room: string, identity: string) {
    this.calls.push(`remove ${identity}`);
    this.participants = this.participants.filter((p) => p.identity !== identity);
  }
  async setRole() {}
  async dispatchAgent(_room: string, agentName: string, metadata: string) {
    this.calls.push(`dispatch ${agentName} ${metadata}`);
  }
  async sendData() {}
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

async function setup(plan: 'free' | 'enterprise' = 'enterprise') {
  const { tenant, user } = await signup(
    db(),
    {
      organization: 'Acme',
      slug: 'acme',
      name: 'Admin',
      email: 'admin@acme.test',
      password: 'senha-muito-segura',
    },
    null,
    plan,
  );
  const choices = await agentChoices(db(), user);
  const [kaiser] = await listAgents(db(), user);
  await updateAgent(
    db(),
    user,
    kaiser.id,
    agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices }),
    null,
  );
  const room = await createRoom(db(), user, createRoomInput.parse({ name: 'Sala' }), null);
  return { tenant, user, room, choices, lk: new FakeLiveKit() };
}

describe('turning the AI on and off in a running meeting', () => {
  it('recognises only the voice agent', () => {
    expect(isVoiceAgent(person('agent-AJ_1', { isAgent: true }))).toBe(true);
    expect(isVoiceAgent(person('agent-AJ_2', { isAgent: true, mode: 'voice' }))).toBe(true);
    expect(isVoiceAgent(person('agent-AJ_3', { isAgent: true, mode: 'captions' }))).toBe(false);
    expect(isVoiceAgent(person('ai-screen', { isAgent: true }))).toBe(false);
    expect(isVoiceAgent(person('agent-x'))).toBe(false);
  });

  it('dispatches the agent into a live room and removes it again', async () => {
    const { tenant, user, room, lk } = await setup();
    lk.participants = [person('u-1'), person('ai-screen', { isAgent: true })];

    const on = await updateRoom(db(), user, room.slug, { agentEnabled: true }, null);
    const fallback = await defaultAgentId(db(), tenant.id);
    expect(on.agentIds).toEqual([fallback]);
    expect(await syncLiveAgents(db(), lk, 'kaiser', on)).toEqual({ removed: 0, dispatched: 1 });
    expect(lk.calls).toEqual([
      `dispatch kaiser {"agentId":"${fallback}","agentName":"Kaiser","tenantId":"${tenant.id}","thinkingSound":true}`,
    ]);

    lk.participants.push(person('agent-AJ_1', { isAgent: true, mode: 'voice', agentId: fallback }));
    lk.participants.push(person('agent-CC', { isAgent: true, mode: 'captions' }));
    expect(await syncLiveAgents(db(), lk, 'kaiser', on)).toEqual({ removed: 0, dispatched: 0 });

    const off = await updateRoom(db(), user, room.slug, { agentEnabled: false }, null);
    expect(off.agentIds).toEqual([]);
    expect(await syncLiveAgents(db(), lk, 'kaiser', off)).toEqual({ removed: 1, dispatched: 0 });
    expect(lk.calls.at(-1)).toBe('remove agent-AJ_1');
    expect(lk.participants.map((p) => p.identity)).toEqual(['u-1', 'ai-screen', 'agent-CC']);
  });

  it('keeps several agents in one room: checking adds one, unchecking removes only that one', async () => {
    const { tenant, user, room, choices, lk } = await setup();
    const kaiser = (await defaultAgentId(db(), tenant.id))!;
    const ana = await createAgent(
      db(),
      user,
      agentInput.parse({ name: 'Ana', description: 'Vendas', instructions: 'x', ...choices }),
      null,
    );
    lk.participants = [person('u-1'), person('agent-K', { isAgent: true, mode: 'voice', agentId: kaiser })];

    const both = await updateRoom(db(), user, room.slug, { agentIds: [kaiser, ana.id] }, null);
    expect(both.agentIds).toEqual([kaiser, ana.id]);
    expect(await syncLiveAgents(db(), lk, 'kaiser', both)).toEqual({ removed: 0, dispatched: 1 });
    expect(lk.calls).toEqual([
      `dispatch kaiser {"agentId":"${ana.id}","agentName":"Ana","agentDescription":"Vendas","tenantId":"${tenant.id}","thinkingSound":true}`,
    ]);

    lk.participants.push(person('agent-A', { isAgent: true, mode: 'voice', agentId: ana.id }));
    const onlyAna = await updateRoom(db(), user, room.slug, { agentIds: [ana.id] }, null);
    expect(await syncLiveAgents(db(), lk, 'kaiser', onlyAna)).toEqual({ removed: 1, dispatched: 0 });
    expect(lk.calls.at(-1)).toBe('remove agent-K');

    await expect(
      updateRoom(db(), user, room.slug, { agentIds: ['00000000-0000-0000-0000-000000000000'] }, null),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('swaps the agent when another one is chosen, and does nothing in an empty room', async () => {
    const { tenant, user, room, choices, lk } = await setup();
    const ana = await createAgent(
      db(),
      user,
      agentInput.parse({ name: 'Ana', instructions: 'x', ...choices }),
      null,
    );
    const on = await updateRoom(db(), user, room.slug, { agentEnabled: true }, null);
    expect(await syncLiveAgents(db(), lk, 'kaiser', on)).toEqual({ removed: 0, dispatched: 0 });

    lk.participants = [person('u-1'), person('agent-AJ_1', { isAgent: true, mode: 'voice' })];
    const swapped = await updateRoom(db(), user, room.slug, { agentId: ana.id }, null);
    expect(await syncLiveAgents(db(), lk, 'kaiser', swapped)).toEqual({ removed: 1, dispatched: 1 });
    expect(lk.calls).toEqual([
      'remove agent-AJ_1',
      `dispatch kaiser {"agentId":"${ana.id}","agentName":"Ana","tenantId":"${tenant.id}","thinkingSound":true}`,
    ]);
  });

  it('never dispatches on plans without AI', async () => {
    const { user, room, lk } = await setup('free');
    lk.participants = [person('u-1'), person('agent-AJ_1', { isAgent: true })];
    const result = await syncLiveAgents(db(), lk, 'kaiser', { ...room, agentIds: ['x'], agentEnabled: true });
    expect(result).toEqual({ removed: 1, dispatched: 0 });
    expect(user.role).toBe('admin');
  });
});
