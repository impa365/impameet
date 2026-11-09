import { badRequest } from '../errors';
import { type NetPolicy, ToolNetworkError, checkToolUrl, outbound } from '../tools/net';
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
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;
const EXTENSIONS = ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'html', 'htm', 'json'] as const;
export type FileKind = (typeof EXTENSIONS)[number];

export function fileKind(name: string): FileKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const kind = (EXTENSIONS as readonly string[]).includes(ext) ? (ext as FileKind) : null;
  if (!kind) throw badRequest('Tipo de arquivo não suportado (use PDF, DOCX, TXT, MD, CSV, HTML ou JSON)');
  return kind;
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** The text of an uploaded file, with headings kept where the format has them. */
export async function extractFile(name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest('Arquivo muito grande (máx. 20 MB)');
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

/** One web page's text (https on the public internet, like every tool URL). */
export async function fetchPage(url: string, net: NetPolicy): Promise<{ title: string; text: string }> {
  try {
    checkToolUrl(url, net);
    const res = await outbound(
      {
        url,
        method: 'GET',
        headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
        timeoutMs: 20_000,
        maxBytes: 5 * 1024 * 1024,
      },
      net,
    );
    if (res.status >= 300 && res.status < 400)
      throw new Error(
        `A página redireciona para ${res.headers.location ?? 'outro endereço'}; use o endereço final`,
      );
    if (res.status !== 200) throw new Error(`A página respondeu HTTP ${res.status}`);
    const type = res.headers['content-type'] ?? '';
    if (type.includes('html')) {
      const page = htmlToText(res.body);
      return { title: page.title, text: page.text.slice(0, MAX_TEXT_CHARS) };
    }
    if (type.includes('text/') || type.includes('json'))
      return { title: '', text: res.body.slice(0, MAX_TEXT_CHARS) };
    throw new Error('A página não é HTML nem texto');
  } catch (err) {
    if (err instanceof ToolNetworkError || err instanceof Error) throw new Error(err.message);
    throw err;
  }
}
