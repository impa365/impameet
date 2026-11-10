/**
 * Spreadsheets (XLSX) and slide decks (PPTX) are zip files of XML. Sheets become Markdown
 * tables (which the chunker turns into "Column: value" sentences) and slides become sections.
 */
import JSZip from 'jszip';

const MAX_ROWS = 5000;
const MAX_COLS = 40;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

/** Refuses zip bombs before anything is inflated (sizes come from the zip's directory). */
async function openZip(bytes: Uint8Array): Promise<JSZip> {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const f of Object.values(zip.files))
    total += (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > MAX_UNZIPPED_BYTES) throw new Error('O arquivo é grande demais depois de descompactado');
  return zip;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });

/** Every <tag>…</tag> text inside a fragment (namespaced names allowed, e.g. a:t). */
const texts = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unescape(m[1]));

const cell = (v: string) => v.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

/** "B7" → column index 1. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const naturalOrder = (a: string, b: string) => {
  const n = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);
  return n(a) - n(b);
};

export async function xlsxToText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const shared = texts((await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '', 'si').map(
    (si) => texts(`<x>${si}</x>`, 't').join('') || si.replace(/<[^>]+>/g, ''),
  );
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescape(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort(naturalOrder);
  const out: string[] = [];
  for (const [i, path] of sheets.entries()) {
    const xml = await zip.file(path)!.async('string');
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) break;
      const values: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const col = ref ? columnIndex(ref) : values.length;
        if (col >= MAX_COLS) continue;
        const type = /\bt="(\w+)"/.exec(attrs)?.[1];
        const raw = texts(body, 'v')[0] ?? texts(body, 't').join('');
        const value = type === 's' ? (shared[Number(raw)] ?? '') : raw;
        values[col] = cell(value);
      }
      if (values.some((v) => v)) rows.push(Array.from(values, (v) => v ?? ''));
    }
    if (rows.length === 0) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
    const [head, ...body] = rows.map(pad);
    out.push(
      `# ${names[i] || `Planilha ${i + 1}`}`,
      '',
      `| ${head.join(' | ')} |`,
      `|${' --- |'.repeat(width)}`,
      ...body.map((r) => `| ${r.join(' | ')} |`),
      '',
    );
  }
  return out.join('\n');
}

export async function pptxToText(bytes: Uint8Array): Promise<string> {
  const zip = await openZip(bytes);
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort(naturalOrder);
  const out: string[] = [];
  for (const [i, path] of slides.entries()) {
    const xml = await zip.file(path)!.async('string');
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => texts(p[1], 'a:t').join('').trim())
      .filter(Boolean);
    const notesPath = path.replace('slides/slide', 'notesSlides/notesSlide');
    const notes = texts((await zip.file(notesPath)?.async('string')) ?? '', 'a:t')
      .join(' ')
      .trim();
    if (paragraphs.length === 0 && !notes) continue;
    const [title, ...rest] = paragraphs;
    out.push(`# ${i + 1}. ${title ?? ''}`.trim(), '', ...rest, ...(notes ? ['', notes] : []), '');
  }
  return out.join('\n');
}
