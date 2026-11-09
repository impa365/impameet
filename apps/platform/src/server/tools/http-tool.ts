import type { z } from 'zod';
import { badRequest } from '../errors';
import type { TOOL_METHODS, agentToolInput } from '../validation';

export type HttpToolInput = Extract<z.infer<typeof agentToolInput>, { kind: 'http' }>;
export type ToolParam = HttpToolInput['params'][number];
export type HttpMethod = (typeof TOOL_METHODS)[number];
export type ToolArgs = Record<string, string | number | boolean>;

export interface HttpToolSpec {
  method: HttpMethod;
  url: string;
  params: ToolParam[];
  bodyTemplate: string | null;
  headers: Record<string, string>;
}

/** What the model gets back, at most (tool results go into its context). */
export const MAX_TOOL_OUTPUT = 4000;
const MAX_STRING_ARG = 2000;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}$/;
const WITH_BODY: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);

/** The JSON schema the model sees for an HTTP tool's parameters. */
export function paramsSchema(params: ToolParam[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      params.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }]),
    ),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

/** Placeholders only in the path and query, only for declared parameters; the body is JSON. */
export function assertHttpTemplate(input: Pick<HttpToolInput, 'url' | 'method' | 'params' | 'bodyTemplate'>) {
  const declared = new Set(input.params.map((p) => p.name));
  const scheme = input.url.indexOf('://');
  const rest = scheme >= 0 ? input.url.slice(scheme + 3) : input.url;
  const hostEnd = rest.search(/[/?#]/);
  const origin = hostEnd >= 0 ? rest.slice(0, hostEnd) : rest;
  if (origin.includes('{{'))
    throw badRequest('Parâmetros só podem aparecer no caminho ou na consulta da URL');
  const used = [...placeholders(input.url), ...placeholders(input.bodyTemplate ?? '')];
  const unknown = used.find((name) => !declared.has(name));
  if (unknown) throw badRequest(`O parâmetro {{${unknown}}} não foi declarado`);
  if (input.bodyTemplate) {
    if (!WITH_BODY.has(input.method)) throw badRequest('Só POST, PUT e PATCH enviam corpo');
    try {
      JSON.parse(input.bodyTemplate);
    } catch {
      throw badRequest('O modelo do corpo precisa ser um JSON válido');
    }
  }
}

/** The model's arguments, typed as declared; anything undeclared is dropped. */
export function coerceArgs(params: ToolParam[], raw: Record<string, unknown>): ToolArgs {
  const out: ToolArgs = {};
  for (const p of params) {
    const value = raw[p.name];
    if (value === undefined || value === null || value === '') {
      if (p.required) throw badRequest(`Falta o parâmetro ${p.name}`);
      continue;
    }
    if (p.type === 'string') {
      if (typeof value === 'object') throw badRequest(`O parâmetro ${p.name} precisa ser um texto`);
      const text = String(value);
      if (text.length > MAX_STRING_ARG) throw badRequest(`O parâmetro ${p.name} é longo demais`);
      out[p.name] = text;
    } else if (p.type === 'boolean') {
      if (value === true || value === 'true') out[p.name] = true;
      else if (value === false || value === 'false') out[p.name] = false;
      else throw badRequest(`O parâmetro ${p.name} precisa ser verdadeiro ou falso`);
    } else {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
      if (!Number.isFinite(n) || (p.type === 'integer' && !Number.isInteger(n)))
        throw badRequest(
          `O parâmetro ${p.name} precisa ser um número${p.type === 'integer' ? ' inteiro' : ''}`,
        );
      out[p.name] = n;
    }
  }
  return out;
}

function fillBody(node: unknown, args: ToolArgs): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(node);
    if (whole) return args[whole[1]] ?? null;
    return node.replace(PLACEHOLDER, (_, name: string) => String(args[name] ?? ''));
  }
  if (Array.isArray(node)) return node.map((n) => fillBody(n, args));
  if (node && typeof node === 'object')
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillBody(v, args)]));
  return node;
}

/** The request a call makes. Arguments never reach the host, the headers or the method. */
export function renderHttp(
  spec: HttpToolSpec,
  args: ToolArgs,
): { url: string; method: HttpMethod; headers: Record<string, string>; body?: string } {
  const inUrl = new Set(placeholders(spec.url));
  // "." and ".." would walk the path to another endpoint of the same host.
  const walks = [...inUrl].find((name) => ['.', '..'].includes(String(args[name] ?? '').trim()));
  if (walks) throw badRequest(`Valor inválido para ${walks}`);
  const url = new URL(
    spec.url.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(String(args[name] ?? ''))),
  );
  const rest = Object.entries(args).filter(([name]) => !inUrl.has(name));
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
    ...spec.headers,
  };
  let body: string | undefined;
  if (WITH_BODY.has(spec.method)) {
    const payload = spec.bodyTemplate
      ? fillBody(JSON.parse(spec.bodyTemplate), args)
      : Object.fromEntries(rest);
    body = JSON.stringify(payload);
    headers['content-type'] = 'application/json';
  } else {
    for (const [name, value] of rest) url.searchParams.append(name, String(value));
  }
  return { url: url.toString(), method: spec.method, headers, body };
}

/** The answer, compact and bounded, for the model. */
export function describeResponse(res: {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}): {
  ok: boolean;
  output: string;
} {
  const ok = res.status >= 200 && res.status < 300;
  let text = res.body.trim();
  if ((res.headers['content-type'] ?? '').includes('json')) {
    try {
      text = JSON.stringify(JSON.parse(text));
    } catch {
      /* not JSON after all: keep the text */
    }
  }
  if (res.status >= 300 && res.status < 400 && res.headers.location)
    text = `redirecionou para ${res.headers.location} (redirecionamentos não são seguidos)`;
  const head = `HTTP ${res.status}${res.truncated ? ' (resposta cortada)' : ''}`;
  return { ok, output: `${head}\n${text}`.slice(0, MAX_TOOL_OUTPUT) };
}
