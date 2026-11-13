import { describe, expect, it } from 'vitest';
import { isRerankModel, modelCategory } from '@/lib/models';
import { MAX_DISCOVERED, readCatalog } from '@/server/integrations/probe';

describe('readCatalog', () => {
  it('reads capabilities from the provider metadata, not only from names', () => {
    const catalog = readCatalog({
      data: [
        { id: 'combo/kb', type: 'embedding' },
        { id: 'alias-1', mode: 'embedding' },
        { id: 'alias-2', capabilities: ['chat', 'embeddings'] },
        { id: 'alias-3', capabilities: { embeddings: true } },
        { id: 'alias-4', capabilities: { embeddings: false, chat: true } },
        { id: 'alias-5', supported_endpoints: ['/v1/embeddings'] },
        { id: 'alias-6', architecture: { output_modalities: ['embeddings'] } },
        { id: 'ranker', type: 'rerank' },
        { id: 'models/gemini-2.5-flash' },
        { id: 42 },
        { id: '' },
        { id: 'x'.repeat(121) },
        null,
        'loose',
        { name: 'no id' },
      ],
    });
    expect(catalog.embeddings).toEqual(['alias-1', 'alias-2', 'alias-3', 'alias-5', 'alias-6', 'combo/kb']);
    expect(catalog.rerankers).toEqual(['ranker']);
    expect(catalog.models).toContain('gemini-2.5-flash');
    expect(catalog.models).toContain('42');
    expect(catalog.models).toContain('alias-4');
    expect(catalog.models).toHaveLength(10);
  });

  it('never cuts embedding or reranking models when the catalog is too long', () => {
    const chat = Array.from({ length: MAX_DISCOVERED + 100 }, (_, n) => ({
      id: `a-${String(n).padStart(5, '0')}`,
    }));
    const catalog = readCatalog({ data: [...chat, { id: 'z-bge-m3' }, { id: 'z-cohere-rerank-v3.5' }] });
    expect(catalog.models).toHaveLength(MAX_DISCOVERED);
    expect(catalog.models).toContain('z-bge-m3');
    expect(catalog.models).toContain('z-cohere-rerank-v3.5');
    expect(catalog.embeddings).toEqual(['z-bge-m3']);
  });

  it('copes with bodies that are not a model list', () => {
    for (const body of [null, {}, { data: 'x' }, []]) expect(readCatalog(body).models).toEqual([]);
  });
});

describe('modelCategory', () => {
  it('knows embedding families whose names do not say "embed"', () => {
    for (const m of [
      'voyage-3',
      'voyage/voyage-law-2',
      'BAAI/bge-m3',
      'intfloat/multilingual-e5-large',
      'thenlper/gte-large',
      'nomic-ai/nomic-v1.5',
      'mxbai-large',
    ])
      expect(modelCategory(m)).toBe('embedding');
    expect(modelCategory('BAAI/bge-reranker-v2-m3')).toBe('other');
    expect(isRerankModel('BAAI/bge-reranker-v2-m3')).toBe(true);
    expect(modelCategory('gpt-4o')).toBe('chat');
    expect(modelCategory('combo/kb', new Set(['combo/kb']))).toBe('embedding');
  });
});
