import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { SPEECH_CATALOG, type SpeechProvider, isSpeechProvider } from '@/lib/providers';
import { assertTenantIntegration, integrationSecret, speechIntegrationKind } from '../integrations/service';
import { assertTenantBases, setAgentBases } from '../knowledge/service';
import type { agentInput } from '../validation';

export type AgentInput = z.infer<typeof agentInput>;
export type TtsLatency = 'low' | 'balanced' | 'normal';

/** Agents carry up to 100k characters of knowledge (UTF-8 can take up to 4 bytes each). */
export const MAX_AGENT_BYTES = 512 * 1024;

/** A saved agent; older ones may still miss a choice (then 
eady is false and it is not dispatched). */
export interface AgentConfig extends Omit<
  AgentInput,
  | 'llmModel'
  | 'sttModel'
  | 'ttsModel'
  | 'llmIntegrationId'
  | 'ttsIntegrationId'
  | 'sttIntegrationId'
  | 'llmTemperature'
  | 'llmMaxTokens'
  | 'llmTimeoutS'
  | 'thinkingVolume'
  | 'ttsLatency'
> {
  id: string;
  tenantId: string;
  llmModel: string | null;
  llmTemperature: number | null;
  llmMaxTokens: number | null;
  llmTimeoutS: number | null;
  thinkingVolume: number | null;
  ttsLatency: TtsLatency | null;
  sttModel: string | null;
  ttsModel: string | null;
  llmIntegrationId: string | null;
  ttsIntegrationId: string | null;
  sttIntegrationId: string | null;
  voiceId: string | null;
  ready: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The main agent every organization starts with (it can be edited like any other). */
export const DEFAULT_AGENT = {
  name: 'Kaiser',
  instructions:
    'Você é Kaiser, um assistente de voz participando de uma reunião ao vivo. ' +
    'Fale sempre em português do Brasil, como numa conversa. ' +
    'Responda em uma ou duas frases curtas, com no máximo vinte e cinco palavras, ' +
    'a menos que peçam explicitamente mais detalhes. Vá direto ao ponto, sem introduções. ' +
    'Nunca use emojis, markdown, listas ou símbolos especiais: tudo o que você escreve será falado. ' +
    'Se não souber algo, diga que não sabe.',
};

const AGENT_COLUMNS = (sql: Sql) => sql`
  id, tenant_id as "tenantId", name, description, instructions, knowledge, greeting, voice_id as "voiceId",
  voices, tts_model as "ttsModel", stt_model as "sttModel", llm_model as "llmModel", listen_mode as "listenMode",
  respond_mode as "respondMode", mute_policy as "mutePolicy",
  moderation_tools as "moderationTools", moderation_rules as "moderationRules", perception,
  insights, insights_access as "insightsAccess", minutes_webhook as "minutesWebhook",
  style_rules as "styleRules",
  llm_temperature::float8 as "llmTemperature", llm_max_tokens as "llmMaxTokens",
  llm_timeout_s as "llmTimeoutS", thinking_volume::float8 as "thinkingVolume", tts_latency as "ttsLatency",
  array(select ak.kb_id::text from agent_knowledge ak where ak.agent_id = agents.id) as "knowledgeBaseIds",
  llm_integration_id as "llmIntegrationId", tts_integration_id as "ttsIntegrationId",
  stt_integration_id as "sttIntegrationId",
  is_default as "isDefault", created_at as "createdAt", updated_at as "updatedAt",
  ${READY(sql)} as ready`;

/** The voice used when the speaker's language has none: Portuguese first, then English, then Spanish. */
function mainVoice(input: AgentInput): string | null {
  return input.voices.pt ?? input.voices.en ?? input.voices.es ?? null;
}

/** SQL: the agent has everything it needs to talk (nothing falls back to the server). */
const READY = (sql: Sql, a = 'agents') =>
  sql.unsafe(`
  (${a}.llm_integration_id is not null and ${a}.llm_model is not null
   and ${a}.tts_integration_id is not null and ${a}.stt_integration_id is not null
   and ${a}.tts_model is not null
   and ${a}.stt_model is not null and ${a}.voices <> '{}'::jsonb
   and ${a}.llm_temperature is not null and ${a}.llm_max_tokens is not null
   and ${a}.llm_timeout_s is not null and ${a}.thinking_volume is not null
   and (${a}.tts_latency is not null or not exists (
     select 1 from integrations i where i.id = ${a}.tts_integration_id and i.kind = 'fish')))`);

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores configuram agentes de IA');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/** The integrations belong to the organization, and each model and voice to its provider. */
async function assertIntegrations(sql: Sql, tenantId: string, input: AgentInput): Promise<SpeechProvider> {
  await assertTenantIntegration(sql, tenantId, input.llmIntegrationId, 'llm');
  const speaks = await speechIntegrationKind(sql, tenantId, input.ttsIntegrationId);
  const listens = await speechIntegrationKind(sql, tenantId, input.sttIntegrationId);
  assertSpeechChoices(speaks, listens, input);
  return speaks;
}

export function assertSpeechChoices(
  speaks: SpeechProvider,
  listens: SpeechProvider,
  input: AgentInput,
): void {
  if (!SPEECH_CATALOG[speaks].ttsModels.includes(input.ttsModel))
    throw badRequest('Escolha um modelo de voz do provedor de voz escolhido');
  if (!SPEECH_CATALOG[listens].sttModels.includes(input.sttModel))
    throw badRequest('Escolha um modelo de transcrição do provedor de transcrição escolhido');
  // Deepgram voices are model names of the chosen family, e.g. flux-bianca-pt.
  if (speaks === 'deepgram' && Object.values(input.voices).some((v) => !v?.startsWith(`${input.ttsModel}-`)))
    throw badRequest('As vozes do Deepgram precisam ser do modelo escolhido (ex.: flux-bianca-pt)');
  if (speaks === 'fish' && !input.ttsLatency) throw badRequest('Escolha a latência da voz da Fish Audio');
}

/** The latency is a Fish Audio setting: other providers keep none. */
function ttsLatencyOf(input: AgentInput, speaks: SpeechProvider): TtsLatency | null {
  return speaks === 'fish' ? (input.ttsLatency ?? null) : null;
}

/** Everyone in the organization may see which agents exist (to pick one for a room). */
/** Just what a picker needs, without the (possibly large) instructions and knowledge. */
export async function listAgentNames(
  sql: Sql,
  tenantId: string,
): Promise<{ id: string; name: string; description: string; isDefault: boolean; ready: boolean }[]> {
  return sql<{ id: string; name: string; description: string; isDefault: boolean; ready: boolean }[]>`
    select id, name, description, is_default as "isDefault", ${READY(sql)} as ready
    from agents where tenant_id = ${tenantId}
    order by is_default desc, name`;
}

export async function listAgents(sql: Sql, user: SessionUser): Promise<AgentConfig[]> {
  return sql<AgentConfig[]>`
    select ${AGENT_COLUMNS(sql)} from agents where tenant_id = ${user.tenantId}
    order by is_default desc, name`;
}

export async function createAgent(sql: Sql, actor: SessionUser, input: AgentInput, ip: string | null) {
  assertAdmin(actor);
  const speaks = await assertIntegrations(sql, actor.tenantId, input);
  await assertTenantBases(sql, actor.tenantId, input.knowledgeBaseIds);
  try {
    const [agent] = await sql<AgentConfig[]>`
      insert into agents (tenant_id, name, description, instructions, knowledge, greeting, voice_id, voices, tts_model, stt_model,
                          llm_model, listen_mode, respond_mode, mute_policy, moderation_tools, moderation_rules,
                          perception, insights, insights_access, minutes_webhook, style_rules,
                          llm_integration_id, tts_integration_id, stt_integration_id,
                          llm_temperature, llm_max_tokens, llm_timeout_s, thinking_volume, tts_latency)
      values (${actor.tenantId}, ${input.name}, ${input.description}, ${input.instructions}, ${input.knowledge}, ${input.greeting},
              ${mainVoice(input)}, ${sql.json(input.voices)}, ${input.ttsModel}, ${input.sttModel}, ${input.llmModel}, ${input.listenMode}, ${input.respondMode},
              ${input.mutePolicy}, ${input.moderationTools}, ${input.moderationRules},
              ${input.perception}, ${input.insights}, ${input.insightsAccess}, ${input.minutesWebhook},
              ${input.styleRules}, ${input.llmIntegrationId}, ${input.ttsIntegrationId}, ${input.sttIntegrationId},
              ${input.llmTemperature}, ${input.llmMaxTokens}, ${input.llmTimeoutS}, ${input.thinkingVolume},
              ${ttsLatencyOf(input, speaks)})
      returning ${AGENT_COLUMNS(sql)}`;
    await setAgentBases(sql, actor.tenantId, agent.id, input.knowledgeBaseIds);
    agent.knowledgeBaseIds = [...new Set(input.knowledgeBaseIds)];
    await audit(sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'agent.created',
      target: agent.name,
      ip,
    });
    return agent;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe um agente com esse nome');
    throw err;
  }
}

export async function updateAgent(
  sql: Sql,
  actor: SessionUser,
  id: string,
  input: AgentInput,
  ip: string | null,
): Promise<AgentConfig> {
  assertAdmin(actor);
  const speaks = await assertIntegrations(sql, actor.tenantId, input);
  await assertTenantBases(sql, actor.tenantId, input.knowledgeBaseIds);
  try {
    const [agent] = await sql<AgentConfig[]>`
      update agents set name = ${input.name}, description = ${input.description},
        instructions = ${input.instructions},
        knowledge = ${input.knowledge}, greeting = ${input.greeting}, voice_id = ${mainVoice(input)},
        voices = ${sql.json(input.voices)},
        tts_model = ${input.ttsModel}, stt_model = ${input.sttModel}, llm_model = ${input.llmModel}, listen_mode = ${input.listenMode},
        respond_mode = ${input.respondMode}, mute_policy = ${input.mutePolicy},
        moderation_tools = ${input.moderationTools}, moderation_rules = ${input.moderationRules},
        perception = ${input.perception}, insights = ${input.insights},
        insights_access = ${input.insightsAccess}, minutes_webhook = ${input.minutesWebhook},
        style_rules = ${input.styleRules},
        llm_integration_id = ${input.llmIntegrationId}, tts_integration_id = ${input.ttsIntegrationId},
        stt_integration_id = ${input.sttIntegrationId},
        llm_temperature = ${input.llmTemperature}, llm_max_tokens = ${input.llmMaxTokens},
        llm_timeout_s = ${input.llmTimeoutS}, thinking_volume = ${input.thinkingVolume},
        tts_latency = ${ttsLatencyOf(input, speaks)},
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId}
      returning ${AGENT_COLUMNS(sql)}`;
    if (!agent) throw notFound('Agente não encontrado');
    await setAgentBases(sql, actor.tenantId, agent.id, input.knowledgeBaseIds);
    agent.knowledgeBaseIds = [...new Set(input.knowledgeBaseIds)];
    await audit(sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'agent.updated',
      target: agent.name,
      ip,
    });
    return agent;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe um agente com esse nome');
    throw err;
  }
}

/** The default agent joins rooms that switch the AI on without choosing a specific agent. */
export async function setDefaultAgent(
  sql: Sql,
  actor: SessionUser,
  id: string,
  ip: string | null,
): Promise<void> {
  assertAdmin(actor);
  await sql.begin(async (tx) => {
    const [agent] = await tx<{ name: string }[]>`
      select name from agents where id = ${id} and tenant_id = ${actor.tenantId} for update`;
    if (!agent) throw notFound('Agente não encontrado');
    await tx`update agents set is_default = false where tenant_id = ${actor.tenantId} and is_default`;
    await tx`update agents set is_default = true where id = ${id}`;
    await audit(tx as unknown as Sql, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      action: 'agent.default',
      target: agent.name,
      ip,
    });
  });
}

export async function deleteAgent(
  sql: Sql,
  actor: SessionUser,
  id: string,
  ip: string | null,
): Promise<void> {
  assertAdmin(actor);
  const [current] = await sql<{ isDefault: boolean }[]>`
    select is_default as "isDefault" from agents where id = ${id} and tenant_id = ${actor.tenantId}`;
  if (!current) throw notFound('Agente não encontrado');
  if (current.isDefault) throw badRequest('Escolha outro agente como padrão antes de apagar este');
  const [agent] = await sql<{ name: string }[]>`
    delete from agents where id = ${id} and tenant_id = ${actor.tenantId} returning name`;
  if (!agent) throw notFound('Agente não encontrado');
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'agent.deleted',
    target: agent.name,
    ip,
  });
}

/** Resolves a room's agent choice; null when the agent is not part of this organization. */
export async function findTenantAgent(sql: Sql, tenantId: string, id: string): Promise<AgentConfig | null> {
  const [agent] = await sql<AgentConfig[]>`
    select ${AGENT_COLUMNS(sql)} from agents where id = ${id} and tenant_id = ${tenantId}`;
  return agent ?? null;
}

export async function defaultAgentId(sql: Sql, tenantId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from agents where tenant_id = ${tenantId} and is_default`;
  return row?.id ?? null;
}

export interface DispatchAgent {
  id: string;
  name: string;
  description: string;
}

/** The agents a room dispatches, in the order they were added. */
export async function roomAgents(sql: Sql, room: { id: string; tenantId: string }): Promise<DispatchAgent[]> {
  return sql<DispatchAgent[]>`
    select a.id, a.name, a.description from room_agents ra
    join agents a on a.id = ra.agent_id and a.tenant_id = ${room.tenantId}
    where ra.room_id = ${room.id} and ${READY(sql, 'a')}
    order by ra.added_at, ra.agent_id`;
}

/** Dispatch metadata the worker reads: which agent to load, what to call itself, what it is for. */
/** Room settings the voice agents apply (and that moderators can change during a meeting). */
export interface AgentRoomSettings {
  thinkingSound: boolean;
  agentActions: boolean;
  /** Who may draw on the whiteboard: an agent reading it ignores everyone else's drawings. */
  boardPolicy?: 'everyone' | 'moderators';
}

export function agentDispatchMetadata(
  tenantId: string,
  agent: DispatchAgent,
  settings: AgentRoomSettings = { thinkingSound: true, agentActions: true },
): string {
  return JSON.stringify({
    agentId: agent.id,
    agentName: agent.name,
    agentDescription: agent.description || undefined,
    tenantId,
    thinkingSound: settings.thinkingSound,
    agentActions: settings.agentActions,
    boardPolicy: settings.boardPolicy ?? 'everyone',
  });
}
export async function createDefaultAgent(sql: Sql, tenantId: string): Promise<void> {
  await sql`
    insert into agents (tenant_id, name, instructions, is_default)
    values (${tenantId}, ${DEFAULT_AGENT.name}, ${DEFAULT_AGENT.instructions}, true)`;
}

export interface WorkerAgent {
  id: string;
  name: string;
  instructions: string;
  knowledge: string;
  greeting: string;
  voiceId: string | null;
  voices: Partial<Record<'pt' | 'en' | 'es', string>>;
  ttsModel: string | null;
  sttModel: string | null;
  llmModel: string | null;
  llmTemperature: number | null;
  llmMaxTokens: number | null;
  llmTimeoutS: number | null;
  thinkingVolume: number | null;
  ttsLatency: TtsLatency | null;
  listenMode: string;
  respondMode: string;
  mutePolicy: string;
  moderationTools: string[];
  moderationRules: string;
  perception: string[];
  insights: string[];
  insightsAccess: string;
  styleRules: string;
  /** Approved answers the agent follows as examples (its "training"). */
  examples: { question: string; answer: string }[];
  /** How many knowledge bases it can search (the worker offers the lookup tool when > 0). */
  knowledgeBases: number;
  /** Present when the agent uses a saved LLM integration (decrypted, internal API only). */
  llm: { baseUrl: string; apiKey: string; model: string } | null;
  /** Speaking and listening providers, each with its own key (decrypted, internal API only). */
  tts: { provider: SpeechProvider; apiKey: string } | null;
  stt: { provider: SpeechProvider; apiKey: string } | null;
}

async function speechSecret(
  sql: Sql,
  key: Buffer,
  tenantId: string,
  id: string,
): Promise<{ provider: SpeechProvider; apiKey: string } | null> {
  const s = await integrationSecret(sql, key, tenantId, id);
  return isSpeechProvider(s.kind) ? { provider: s.kind, apiKey: s.apiKey } : null;
}

/** What the voice worker needs, looked up by id only (called with the internal token). */
export async function agentForWorker(sql: Sql, key: Buffer | null, id: string): Promise<WorkerAgent | null> {
  const [row] = await sql<(AgentConfig & { tenantStatus: string })[]>`
    select ${AGENT_COLUMNS(sql)}, (select status from tenants t where t.id = agents.tenant_id) as "tenantStatus"
    from agents where id = ${id}`;
  if (!row || row.tenantStatus !== 'active') return null;

  let llm: WorkerAgent['llm'] = null;
  let tts: WorkerAgent['tts'] = null;
  let stt: WorkerAgent['stt'] = null;
  if (key && row.llmIntegrationId) {
    const s = await integrationSecret(sql, key, row.tenantId, row.llmIntegrationId);
    llm = { baseUrl: s.baseUrl ?? '', apiKey: s.apiKey, model: row.llmModel ?? '' };
  }
  if (key && row.ttsIntegrationId) tts = await speechSecret(sql, key, row.tenantId, row.ttsIntegrationId);
  if (key && row.sttIntegrationId) stt = await speechSecret(sql, key, row.tenantId, row.sttIntegrationId);
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    knowledge: row.knowledge,
    greeting: row.greeting,
    voiceId: row.voiceId,
    voices: row.voices,
    ttsModel: row.ttsModel,
    sttModel: row.sttModel,
    llmModel: row.llmModel,
    llmTemperature: row.llmTemperature,
    llmMaxTokens: row.llmMaxTokens,
    llmTimeoutS: row.llmTimeoutS,
    thinkingVolume: row.thinkingVolume,
    ttsLatency: row.ttsLatency,
    listenMode: row.listenMode,
    respondMode: row.respondMode,
    mutePolicy: row.mutePolicy,
    moderationTools: row.moderationTools,
    moderationRules: row.moderationRules,
    perception: row.perception,
    insights: row.insights,
    insightsAccess: row.insightsAccess,
    styleRules: row.styleRules,
    examples: await sql<{ question: string; answer: string }[]>`
      select question, answer from agent_examples
      where agent_id = ${row.id} and enabled order by created_at limit 30`,
    knowledgeBases: row.knowledgeBaseIds.length,
    llm,
    tts,
    stt,
  };
}
