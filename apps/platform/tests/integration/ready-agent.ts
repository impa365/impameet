import { randomBytes } from 'node:crypto';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { createIntegration } from '@/server/integrations/service';
import { integrationInput } from '@/server/validation';

/** The key the helper's integrations are sealed with (tests that read them back need it). */
export const READY_AGENT_KEY = randomBytes(32);
const KEY = READY_AGENT_KEY;

/** How the agent thinks and sounds (chosen per agent like its providers). */
export const AGENT_TUNING = {
  llmTemperature: 0.6,
  llmMaxTokens: 400,
  llmTimeoutS: 15,
  thinkingVolume: 0.5,
  ttsLatency: 'balanced',
} as const;

/**
 * Everything an agent has to choose (there is no server provider, model or voice): an LLM and a
 * Fish Audio integration of the organization (speaking and listening), the models and one voice.
 */
export async function agentChoices(sql: Sql, admin: SessionUser) {
  const deps = { sql, key: KEY, resolve: async () => ['93.184.215.14'] };
  const llm = await createIntegration(
    deps,
    admin,
    integrationInput.parse({
      kind: 'llm',
      name: 'LLM de teste',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-0123456789abcdef',
      defaultModel: 'deepseek/deepseek-chat',
    }),
    null,
  );
  const fish = await createIntegration(
    deps,
    admin,
    integrationInput.parse({ kind: 'fish', name: 'Fish de teste', apiKey: 'fish-0123456789abcdef' }),
    null,
  );
  return {
    llmIntegrationId: llm.id,
    ttsIntegrationId: fish.id,
    sttIntegrationId: fish.id,
    llmModel: 'deepseek/deepseek-chat',
    ttsModel: 's2.1-pro',
    sttModel: 'transcribe-stream-1',
    voices: { pt: 'voz-teste-1' },
    ...AGENT_TUNING,
  };
}
