import { badRequest } from '../errors';
import { type NetPolicy, ToolNetworkError, checkToolUrl, outbound } from '../tools/net';
import type { Fetched, Get } from './crawl';
import { pptxToText, xlsxToText } from './office';
import { htmlToText } from './text';

/** Texts to vectors, from the embedding integration the admin chose. */
export type Embed = (texts: string[]) => Promise<number[][]>;

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const BATCH = 64;
/** What one piece may weigh when embedded (providers cap input size). */
const MAX_INPUT_CHARS = 8000;

export function openAiEmbedder(config: EmbeddingConfig, fetchImpl: typeof fetch = fetch): Embed {
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const input = texts.slice(i, i + BATCH).map((t) => t.slice(0, MAX_INPUT_CHARS));
      const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.model, input }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`O provedor de embeddings respondeu ${res.status}`);
      const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
      const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== input.length || rows.some((r) => !Array.isArray(r.embedding)))
        throw new Error('O provedor de embeddings não devolveu todos os vetores');
      out.push(...rows.map((r) => r.embedding!));
    }
    return out;
  };
}

/** Files people upload, and what we read from them. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;
const EXTENSIONS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'txt',
  'md',
  'markdown',
  'csv',
  'html',
  'htm',
  'json',
] as const;
export type FileKind = (typeof EXTENSIONS)[number];

export function fileKind(name: string): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const kind = (EXTENSIONS as readonly string[]).includes(ext) ? (ext as FileKind) : null;
  if (!kind)
    throw badRequest('Tipo de arquivo não suportado (use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, HTML ou JSON)');
  return kind;
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** The text of an uploaded file, with headings kept where the format has them. */
export async function extractFile(name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest('Arquivo muito grande (máx. 50 MB)');
  const kind = fileKind(name);
  let text: string;
  try {
    if (kind === 'pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text: pages } = await extractText(pdf, { mergePages: false });
      text = (Array.isArray(pages) ? pages : [pages]).join('\n\n');
    } else if (kind === 'docx') {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
      text = htmlToText(value).text;
    } else if (kind === 'xlsx') {
      text = await xlsxToText(bytes);
    } else if (kind === 'pptx') {
      text = await pptxToText(bytes);
    } else if (kind === 'html' || kind === 'htm') {
      text = htmlToText(decode(bytes)).text;
    } else {
      text = decode(bytes);
    }
  } catch {
    throw badRequest('Não foi possível ler o arquivo');
  }
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw badRequest('O arquivo não tem texto que dê para ler (PDFs escaneados precisam de OCR)');
  return text.slice(0, MAX_TEXT_CHARS);
}

/** One web page's text (https on the public internet, like every tool URL; redirects are followed). */
export async function fetchPage(
  url: string,
  net: NetPolicy,
  get: Get,
): Promise<{ title: string; text: string; url: string }> {
  try {
    checkToolUrl(url, net);
    const res = await get(url);
    if (res.status !== 200) throw new Error(`A página respondeu HTTP ${res.status}`);
    const type = res.headers['content-type'] ?? '';
    if (type.includes('html')) {
      const page = htmlToText(res.body);
      return { title: page.title, text: page.text.slice(0, MAX_TEXT_CHARS), url: res.url };
    }
    if (type.includes('text/') || type.includes('json'))
      return { title: '', text: res.body.slice(0, MAX_TEXT_CHARS), url: res.url };
    throw new Error('A página não é HTML nem texto');
  } catch (err) {
    if (err instanceof ToolNetworkError || err instanceof Error) throw new Error(err.message);
    throw err;
  }
}

const MAX_HOPS = 4;

/**
 * GET through the outbound guard, following redirects one hop at a time (each hop is checked
 * again, so a redirect can never lead to a private address).
 */
export function webGet(net: NetPolicy): Get {
  return async (start) => {
    let url = start;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const youtube = /(^|\.)youtube\.com$/.test(new URL(url).hostname);
      const res = await outbound(
        {
          url,
          method: 'GET',
          headers: {
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
            'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8,es;q=0.7',
            ...(youtube
              ? {
                  'user-agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
                  cookie: 'CONSENT=YES+',
                }
              : {}),
          },
          timeoutMs: 20_000,
          maxBytes: 6 * 1024 * 1024,
        },
        net,
      );
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        continue;
      }
      return { url, status: res.status, headers: res.headers, body: res.body } satisfies Fetched;
    }
    throw new Error('Redirecionamentos demais');
  };
}
