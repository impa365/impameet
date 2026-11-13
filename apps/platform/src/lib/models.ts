/** Groups the model names a provider lists, so the admin can find the right one quickly. */

export const MODEL_CATEGORIES = [
  'chat',
  'reasoning',
  'code',
  'embedding',
  'audio',
  'image',
  'other',
] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export function modelCategory(id: string): ModelCategory {
  const s = id.toLowerCase();
  if (s.includes('embed')) return 'embedding';
  if (/moderation|rerank|guard/.test(s)) return 'other';
  if (/tts|whisper|transcri|speech|audio|realtime/.test(s)) return 'audio';
  if (/dall-e|image|imagen|flux|stable-diffusion|sdxl|sora|veo/.test(s)) return 'image';
  if (/coder|codestral|codex|devstral/.test(s)) return 'code';
  if (/(^|\/)o\d(-|$)|reason|thinking|qwq|(^|[-/])r1($|[-:])/.test(s)) return 'reasoning';
  return 'chat';
}

/** How many models of each category, in the fixed category order (empty ones left out). */
export function categoryCounts(models: readonly string[]): [ModelCategory, number][] {
  const counts = new Map<ModelCategory, number>();
  for (const m of models) {
    const c = modelCategory(m);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return MODEL_CATEGORIES.filter((c) => counts.has(c)).map((c) => [c, counts.get(c) ?? 0]);
}

/** The models matching a search (any word, in any order) and, optionally, one category. */
export function filterModels(
  models: readonly string[],
  query: string,
  category: ModelCategory | 'all' = 'all',
): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(
    (m) =>
      (category === 'all' || modelCategory(m) === category) &&
      words.every((w) => m.toLowerCase().includes(w)),
  );
}

/** Reranking models (Cohere, Jina, Voyage and the routers that serve them) say so in their name. */
export const isRerankModel = (model: string) => /rerank/i.test(model);

/** Embedding models first (for the embeddings form), each group keeping the given order. */
export function embeddingsFirst(models: readonly string[]): string[] {
  const embedding = models.filter((m) => modelCategory(m) === 'embedding');
  return [...embedding, ...models.filter((m) => modelCategory(m) !== 'embedding')];
}
