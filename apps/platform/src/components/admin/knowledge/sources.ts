import { isRerankModel, modelCategory } from '@/lib/models';
import type { Integration } from '../IntegrationsTab';

/** An integration a base can use for one capability, with the models it offers for it. */
export interface CapabilitySource {
  integration: Integration;
  models: string[];
  /** False until "Testar conexão" proved this capability with a real call. */
  proven: boolean;
}

/**
 * Integrations that embed: the embedding ones (their single model) and the OpenAI-compatible LLM
 * ones where the admin enabled embedding models, so one key can serve chat and the bases.
 */
export function embeddingSources(list: Integration[]): CapabilitySource[] {
  return list.flatMap((i): CapabilitySource[] => {
    if (i.kind === 'embedding' && i.defaultModel)
      return [{ integration: i, models: [i.defaultModel], proven: i.capabilities.includes('embeddings') }];
    const models = i.kind === 'llm' ? i.models.filter((m) => modelCategory(m) === 'embedding') : [];
    return models.length ? [{ integration: i, models, proven: i.capabilities.includes('embeddings') }] : [];
  });
}

/** Integrations that rerank: the rerank ones and LLM ones where reranking models are enabled. */
export function rerankSources(list: Integration[]): CapabilitySource[] {
  return list.flatMap((i): CapabilitySource[] => {
    if (i.kind === 'rerank' && i.defaultModel)
      return [{ integration: i, models: [i.defaultModel], proven: i.capabilities.includes('rerank') }];
    const models = i.kind === 'llm' ? i.models.filter(isRerankModel) : [];
    return models.length ? [{ integration: i, models, proven: i.capabilities.includes('rerank') }] : [];
  });
}
