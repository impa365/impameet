/** One chat completion from an OpenAI-compatible API (the agent's own LLM integration). */
export interface CompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  /** Ask for a JSON object; providers that refuse it get the plain request instead. */
  json?: boolean;
}

export type Complete = (req: CompletionRequest) => Promise<string>;

const TIMEOUT_MS = 120_000;

export function openAiComplete(fetchImpl: typeof fetch = fetch): Complete {
  return async (req) => {
    const call = (json: boolean) =>
      fetchImpl(`${req.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${req.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: 0.2,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let res = await call(Boolean(req.json));
    if (req.json && res.status === 400) res = await call(false);
    if (!res.ok) throw new Error(`llm_http_${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('llm_empty');
    return content;
  };
}

/** The first JSON object in a model's answer (some wrap it in prose or ``` fences). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('llm_not_json');
  return JSON.parse(text.slice(start, end + 1));
}
