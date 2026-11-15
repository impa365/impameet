import { describe, expect, it } from 'vitest';
import { agentHealthEventInput } from '@/server/validation';

describe('agent health event input', () => {
  it('accepts a pipeline error without conversation content', () => {
    const parsed = agentHealthEventInput.parse({
      room: 'tenant.room-slug',
      kind: 'pipeline_error',
      code: 'llm',
      source: 'llm',
      detail: 'LLMStream:APIError',
      sessionId: 'agent-abc',
    });
    expect(parsed.code).toBe('llm');
    expect(parsed.kind).toBe('pipeline_error');
  });

  it('accepts a deliberate skip', () => {
    expect(
      agentHealthEventInput.parse({
        room: 'tenant.demo',
        kind: 'skipped_reply',
        code: 'not_addressed',
      }).code,
    ).toBe('not_addressed');
  });

  it('rejects unknown kinds and overlong detail', () => {
    expect(() => agentHealthEventInput.parse({ room: 'r', kind: 'weird', code: 'x' })).toThrow();
    expect(() =>
      agentHealthEventInput.parse({
        room: 'r',
        kind: 'joined',
        code: 'ok',
        detail: 'x'.repeat(201),
      }),
    ).toThrow();
  });
});
