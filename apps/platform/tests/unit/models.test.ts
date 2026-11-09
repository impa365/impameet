import { describe, expect, it } from 'vitest';
import { categoryCounts, embeddingsFirst, filterModels, modelCategory } from '@/lib/models';
import { modelDiscoveryInput } from '@/server/validation';

describe('model categories', () => {
  it.each([
    ['gpt-4.1-mini', 'chat'],
    ['gpt-4o', 'chat'],
    ['deepseek/deepseek-chat', 'chat'],
    ['meta-llama/llama-3.2-90b-vision-instruct', 'chat'],
    ['o3-mini', 'reasoning'],
    ['openai/o1', 'reasoning'],
    ['deepseek-reasoner', 'reasoning'],
    ['deepseek/deepseek-r1', 'reasoning'],
    ['deepseek-r1:70b', 'reasoning'],
    ['qwen/qwq-32b', 'reasoning'],
    ['claude-3-7-sonnet-thinking', 'reasoning'],
    ['codestral-latest', 'code'],
    ['qwen/qwen-2.5-coder-32b-instruct', 'code'],
    ['text-embedding-3-small', 'embedding'],
    ['mistral-embed', 'embedding'],
    ['whisper-1', 'audio'],
    ['gpt-4o-mini-tts', 'audio'],
    ['gpt-4o-transcribe', 'audio'],
    ['gpt-4o-realtime-preview', 'audio'],
    ['dall-e-3', 'image'],
    ['gpt-image-1', 'image'],
    ['black-forest-labs/flux-1.1-pro', 'image'],
    ['omni-moderation-latest', 'other'],
    ['meta-llama/llama-guard-3-8b', 'other'],
  ])('%s is %s', (id, category) => {
    expect(modelCategory(id)).toBe(category);
  });

  it('counts categories in a fixed order and leaves empty ones out', () => {
    expect(categoryCounts(['gpt-4o', 'o3', 'text-embedding-3-large', 'gpt-4.1', 'whisper-1'])).toEqual([
      ['chat', 2],
      ['reasoning', 1],
      ['embedding', 1],
      ['audio', 1],
    ]);
    expect(categoryCounts([])).toEqual([]);
  });

  it('filters by every word of the search and by category', () => {
    const all = ['openai/gpt-4o-mini', 'openai/gpt-4.1', 'anthropic/claude-3.5-haiku', 'openai/o3-mini'];
    expect(filterModels(all, '')).toEqual(all);
    expect(filterModels(all, '  MINI  openai ')).toEqual(['openai/gpt-4o-mini', 'openai/o3-mini']);
    expect(filterModels(all, 'mini', 'reasoning')).toEqual(['openai/o3-mini']);
    expect(filterModels(all, '', 'chat')).toHaveLength(3);
    expect(filterModels(all, 'gemini')).toEqual([]);
  });

  it('puts embedding models first, keeping the order within each group', () => {
    expect(embeddingsFirst(['gpt-4o', 'text-embedding-3-small', 'a-embed', 'o1'])).toEqual([
      'text-embedding-3-small',
      'a-embed',
      'gpt-4o',
      'o1',
    ]);
  });
});

describe('model discovery input', () => {
  it('takes a typed key or a saved integration, only for listable kinds', () => {
    expect(
      modelDiscoveryInput.parse({
        kind: 'llm',
        baseUrl: ' https://api.openai.com/v1 ',
        apiKey: 'sk-12345678',
      }),
    ).toEqual({ kind: 'llm', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-12345678' });
    const id = '0b6f4a52-7d0e-4f5e-9c39-3c1f1f8a6d21';
    expect(
      modelDiscoveryInput.parse({ kind: 'embedding', baseUrl: 'https://x.test/v1', integrationId: id }),
    ).toMatchObject({ integrationId: id });
    expect(modelDiscoveryInput.safeParse({ kind: 'fish', baseUrl: 'https://x.test' }).success).toBe(false);
    expect(modelDiscoveryInput.safeParse({ kind: 'llm', baseUrl: '' }).success).toBe(false);
    expect(
      modelDiscoveryInput.safeParse({ kind: 'llm', baseUrl: 'https://x.test', apiKey: 'short' }).success,
    ).toBe(false);
  });
});
