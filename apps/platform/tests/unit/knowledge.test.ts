import { describe, expect, it } from 'vitest';
import { probeEmbedding } from '@/server/integrations/probe';
import { extractFile, fileKind, openAiEmbedder } from '@/server/knowledge/ingest';
import { collectionName } from '@/server/knowledge/qdrant';
import { chunkText, contentHash, htmlToText, keywords, sparseVector } from '@/server/knowledge/text';
import { integrationInput, knowledgeSourceInput } from '@/server/validation';

/** A one-page PDF with real text (the smallest valid file pdf.js reads). */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}

describe('cutting documents into pieces', () => {
  it('keeps each piece under its heading, with overlap, and short tails glued', () => {
    const text = [
      '# Produto',
      '## Preços',
      'O plano Pro custa R$ 99.',
      '## Suporte',
      Array.from({ length: 40 }, (_, i) => `Frase número ${i} sobre o atendimento ao cliente.`).join(' '),
    ].join('\n');
    const pieces = chunkText(text, 400, 60);
    expect(pieces[0]).toEqual({
      section: 'Produto > Preços',
      content: 'Produto > Preços\nO plano Pro custa R$ 99.',
    });
    const support = pieces.filter((p) => p.section === 'Produto > Suporte');
    expect(support.length).toBeGreaterThan(3);
    for (const p of support) {
      expect(p.content.startsWith('Produto > Suporte\n')).toBe(true);
      expect(p.content.length).toBeLessThanOrEqual(520);
    }
    // the start of each piece repeats the end of the one before
    const tail = support[0].content.slice(-20).split(' ').slice(-1)[0];
    expect(support[1].content).toContain(tail);
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(chunkText('x'.repeat(2500), 1000, 0).map((p) => p.content.length)).toEqual([1000, 1000, 500]);
  });

  it('turns tables into sentences retrieval understands', () => {
    const [piece] = chunkText('| Plano | Preço |\n| --- | --- |\n| Pro | R$ 99 |\n| Max | R$ 199 |');
    expect(piece.content).toBe('Plano: Pro, Preço: R$ 99.\nPlano: Max, Preço: R$ 199');
    expect(chunkText('| só | uma |')[0].content).toBe('| só | uma |');
  });

  it('reads HTML as text with headings, lists and table rows, without scripts', () => {
    const { title, text } = htmlToText(
      '<html><head><title> Loja  X </title><style>.a{}</style></head><body><nav>menu</nav>' +
        '<h2>Planos</h2><p>Pro&nbsp;&amp; Max &#8212; &#x41;</p><ul><li>Um</li><li>Dois</li></ul>' +
        '<table><tr><td>A</td><td>B</td></tr></table><script>alert(1)</script><!-- x --></body></html>',
    );
    expect(title).toBe('Loja X');
    expect(text).toContain('## Planos');
    expect(text).toContain('Pro & Max — A');
    expect(text).toContain('- Um\n- Dois');
    expect(text).toContain('| A | B |');
    expect(text).not.toMatch(/alert|menu|\.a\{/);
    expect(htmlToText('<p>&bogus; &#0;</p>').text).toBe('&bogus;');
  });

  it('builds keyword vectors without accents or common words, the same way every time', () => {
    expect(keywords('O Preço do plano é ÓTIMO, não é?')).toEqual(['preco', 'plano', 'otimo']);
    const a = sparseVector('preço preço plano');
    const b = sparseVector('Preco plano preco');
    expect(a).toEqual(b);
    expect(a.indices).toHaveLength(2);
    expect([...a.values].sort()).toEqual([1, 1 + Math.log(2)]);
    expect(a.indices).toEqual([...a.indices].sort((x, y) => x - y));
    expect(sparseVector('o a de')).toEqual({ indices: [], values: [] });
  });

  it('names collections safely and fingerprints content', async () => {
    expect(collectionName('1b4e28ba-2fa1-11d2-883f-0016d3cca427')).toBe(
      'impameet_kb_1b4e28ba2fa111d2883f0016d3cca427',
    );
    expect(await contentHash('a')).toBe(await contentHash('a'));
    expect(await contentHash('a')).not.toBe(await contentHash('b'));
  });
});

describe('reading files', () => {
  it('accepts the common document types only', () => {
    expect(fileKind('Manual.PDF')).toBe('pdf');
    expect(fileKind('a.docx')).toBe('docx');
    expect(() => fileKind('virus.exe')).toThrow(/não suportado/);
    expect(() => fileKind('semextensao')).toThrow(/não suportado/);
  });

  it('extracts text from PDF, HTML and plain files', async () => {
    expect(await extractFile('tabela.pdf', tinyPdf('Plano Pro custa 99 reais'))).toContain(
      'Plano Pro custa 99 reais',
    );
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await extractFile('a.html', enc('<h1>Oi</h1><p>mundo</p>'))).toBe('# Oi\n\nmundo');
    expect(await extractFile('a.md', enc('# Título\n\ntexto\u0000'))).toBe('# Título\n\ntexto');
    await expect(extractFile('a.txt', enc('   '))).rejects.toThrow(/não tem texto/);
    await expect(extractFile('a.pdf', enc('não é pdf'))).rejects.toThrow(/Não foi possível ler/);
    await expect(extractFile('a.docx', enc('não é docx'))).rejects.toThrow(/Não foi possível ler/);
    await expect(extractFile('a.xlsx', enc('não é planilha'))).rejects.toThrow(/Não foi possível ler/);
    await expect(extractFile('big.txt', new Uint8Array(51 * 1024 * 1024))).rejects.toThrow(/muito grande/);
  });

  it('accepts spreadsheets and slide decks', () => {
    expect(fileKind('Preços.XLSX')).toBe('xlsx');
    expect(fileKind('aula.pptx')).toBe('pptx');
  });
});

describe('embeddings', () => {
  it('batches, keeps order and checks what comes back', async () => {
    const seen: { model: string; input: string[] }[] = [];
    const fetchOk = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; input: string[] };
      seen.push(body);
      // answered out of order: the client sorts by index
      const data = body.input.map((t, index) => ({ index, embedding: [t.length, index] })).reverse();
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const embed = openAiEmbedder(
      { baseUrl: 'https://api.example.com/v1/', apiKey: 'k', model: 'm' },
      fetchOk,
    );
    const texts = Array.from({ length: 130 }, (_, i) => 'x'.repeat(i + 1));
    const vectors = await embed(texts);
    expect(seen.map((s) => s.input.length)).toEqual([64, 64, 2]);
    expect(seen[0].model).toBe('m');
    expect(vectors[0]).toEqual([1, 0]);
    expect(vectors[129]).toEqual([130, 1]);

    const bad = openAiEmbedder(
      { baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    );
    await expect(bad(['a'])).rejects.toThrow(/401/);
    const short = openAiEmbedder(
      { baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(short(['a'])).rejects.toThrow(/todos os vetores/);
  });

  it('tests an embedding integration with one tiny input and reports the size', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(await probeEmbedding(ok, 'https://x/v1', 'k', 'modelo')).toEqual({
      ok: true,
      models: ['modelo (3)'],
    });
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    expect((await probeEmbedding(denied, 'https://x/v1', 'k', 'm')).ok).toBe(false);
    const empty = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await probeEmbedding(empty, 'https://x/v1', 'k', 'm')).toEqual({
      ok: false,
      error: 'O provedor não devolveu um embedding',
    });
    const down = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect((await probeEmbedding(down, 'https://x/v1', 'k', 'm')).ok).toBe(false);
  });

  it('validates the embedding integration and the sources', () => {
    expect(
      integrationInput.safeParse({
        kind: 'embedding',
        name: 'E',
        baseUrl: 'https://x',
        apiKey: 'k'.repeat(10),
        defaultModel: 'm',
      }).success,
    ).toBe(true);
    expect(
      integrationInput.safeParse({
        kind: 'embedding',
        name: 'E',
        baseUrl: 'https://x',
        apiKey: 'k'.repeat(10),
      }).success,
    ).toBe(false);
    expect(knowledgeSourceInput.safeParse({ kind: 'url', url: 'ftp://x' }).success).toBe(false);
    expect(knowledgeSourceInput.parse({ kind: 'url', url: 'https://x.com/a' })).toMatchObject({ title: '' });
    expect(knowledgeSourceInput.safeParse({ kind: 'qa', title: 'F', pairs: [] }).success).toBe(false);
  });
});
