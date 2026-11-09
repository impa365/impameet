/**
 * Text handling for the knowledge bases: turning documents into plain text with headings,
 * cutting them into pieces that keep their section, and the keyword ("sparse") vector Qdrant
 * uses next to the meaning ("dense") vector for hybrid search.
 */

export interface Piece {
  section: string;
  content: string;
}

/** Pieces of about this many characters, overlapping so an idea cut in two is still found. */
export const PIECE_CHARS = 1200;
export const OVERLAP_CHARS = 150;
const MIN_PIECE_CHARS = 200;
const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Recursive split at the most natural boundary that keeps pieces under the limit. */
function split(text: string, limit: number, seps = SEPARATORS): string[] {
  if (text.length <= limit) return [text];
  const [sep, ...rest] = seps;
  if (sep === undefined) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
    return out;
  }
  const parts = text.split(sep);
  if (parts.length === 1) return split(text, limit, rest);
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    const piece = current ? current + sep + part : part;
    if (piece.length <= limit) {
      current = piece;
      continue;
    }
    if (current) out.push(current);
    if (part.length > limit) {
      out.push(...split(part, limit, rest));
      current = '';
    } else current = part;
  }
  if (current) out.push(current);
  return out;
}

/** A Markdown table as sentences ("Plano: Pro, Preço: R$ 99"), which retrieval finds far better. */
function tableSentences(block: string): string | null {
  const rows = block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && l.endsWith('|'));
  if (rows.length < 3 || !/^\|[\s:|-]+\|$/.test(rows[1])) return null;
  const cells = (row: string) =>
    row
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
  const head = cells(rows[0]);
  return rows
    .slice(2)
    .map((r) =>
      cells(r)
        .map((v, i) => (head[i] ? `${head[i]}: ${v}` : v))
        .filter((s) => s.trim())
        .join(', '),
    )
    .join('.\n');
}

/** Pieces that remember the headings they sit under (prefixed, so each piece stands on its own). */
export function chunkText(text: string, limit = PIECE_CHARS, overlap = OVERLAP_CHARS): Piece[] {
  const sections: { path: string[]; body: string[] }[] = [{ path: [], body: [] }];
  let path: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      path = [...path.slice(0, h[1].length - 1), h[2]];
      sections.push({ path, body: [] });
    } else sections[sections.length - 1].body.push(line);
  }
  const pieces: Piece[] = [];
  for (const s of sections) {
    const raw = s.body.join('\n').trim();
    if (!raw) continue;
    const body = raw
      .split(/\n{2,}/)
      .map((block) => tableSentences(block) ?? block)
      .join('\n\n');
    const section = s.path.join(' > ');
    const prefix = section ? `${section}\n` : '';
    const parts = split(body, limit - prefix.length);
    for (let i = 0; i < parts.length; i++) {
      const tail = i > 0 && overlap > 0 ? parts[i - 1].slice(-overlap) : '';
      const start = tail ? tail.slice(Math.max(0, tail.indexOf(' ') + 1)) : '';
      pieces.push({ section, content: `${prefix}${start ? `${start} ` : ''}${parts[i]}`.trim() });
    }
  }
  // A tiny last piece of a section reads better glued to the one before it.
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.section === p.section &&
      p.content.length < MIN_PIECE_CHARS &&
      last.content.length + p.content.length < limit * 1.3
    )
      last.content = `${last.content}\n${p.content}`;
    else merged.push({ ...p });
  }
  return merged;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML as plain text with Markdown headings, list bullets and table rows; scripts dropped. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<tr\b[^>]*>/gi, '\n| ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|ul|ol|table|blockquote|pre)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    });
  const text = s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title.replace(/\s+/g, ' '), text };
}

const plain = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Compared without accents, like the words they filter. */
const STOPWORDS = new Set(
  plain(
    'a o e é de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos à às ' +
      'os as ou mas como mais menos muito seu sua seus suas ele ela eles elas eu tu nós vós isso isto ' +
      'esse essa este esta aquele aquela já não sim ser foi são está estão tem ter há the of and to in ' +
      'is it for on with as at by be or an are this that from el la los las del al lo y en es por con ' +
      'su sus para una unos unas',
  ).split(' '),
);

/** Lowercase words without accents, minus the most common ones. */
export function keywords(text: string): string[] {
  return plain(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** 32-bit FNV-1a: the same word always lands on the same index. */
function fnv1a(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The keyword vector of a text: term frequencies (dampened) at hashed indices. Qdrant applies
 * the inverse document frequency itself (collection created with `modifier: idf`).
 */
export function sparseVector(text: string): { indices: number[]; values: number[] } {
  const counts = new Map<number, number>();
  for (const w of keywords(text)) {
    const i = fnv1a(w);
    counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  const indices = [...counts.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => 1 + Math.log(counts.get(i)!)) };
}

/** A stable fingerprint of a text, to skip re-embedding what did not change. */
export async function contentHash(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}
