import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  type Fetched,
  type Get,
  discoverPages,
  globToRegExp,
  normalizeUrl,
  pageLinks,
  parseSitemap,
  pathAllowed,
  robotsRules,
} from '@/server/knowledge/crawl';
import { pptxToText, xlsxToText } from '@/server/knowledge/office';
import { httpReranker } from '@/server/knowledge/rerank';
import { chunkText } from '@/server/knowledge/text';
import {
  clock,
  clockSeconds,
  fetchTranscript,
  jsonAfter,
  momentUrl,
  parseJson3,
  parseXmlCaptions,
  pickTrack,
  playlistVideos,
  transcriptText,
  youTubePlaylistId,
  youTubeVideoId,
} from '@/server/knowledge/youtube';
import {
  knowledgeBaseSettings,
  knowledgeChunkPatch,
  knowledgeCrawlInput,
  knowledgeSourceInput,
  knowledgeSourceUpdate,
  knowledgeWebsiteInput,
} from '@/server/validation';

/** A fake web: path → [status, content type, body]; anything else is a 404. */
function web(site: Record<string, [number, string, string]>, redirects: Record<string, string> = {}): Get {
  return async (url): Promise<Fetched> => {
    const final = redirects[url] ?? url;
    const hit = site[final];
    if (!hit) return { url: final, status: 404, headers: {}, body: '' };
    return { url: final, status: hit[0], headers: { 'content-type': hit[1] }, body: hit[2] };
  };
}
const html = (title: string, body = '') =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const H = 'text/html; charset=utf-8';

describe('finding the pages of a website', () => {
  it('normalizes addresses, matches path patterns and reads robots.txt and sitemaps', () => {
    expect(normalizeUrl('HTTPS://Exemplo.COM/a/?utm_source=x#top')).toBe('https://exemplo.com/a');
    expect(normalizeUrl('/b', 'https://exemplo.com/a')).toBe('https://exemplo.com/b');
    expect(normalizeUrl('ftp://exemplo.com/x')).toBeNull();
    expect(normalizeUrl('http://[nope')).toBeNull();
    expect(globToRegExp('/blog/*').test('/blog/post-1')).toBe(true);
    expect(globToRegExp('/a.b').test('/aXb')).toBe(false);
    expect(pathAllowed('/blog/x', ['/blog/*'], [])).toBe(true);
    expect(pathAllowed('/loja', ['/blog/*'], [])).toBe(false);
    expect(pathAllowed('/blog/rascunho', [' '], ['/blog/rascunho'])).toBe(false);
    expect(
      robotsRules(
        'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /privado # x\nDisallow:\nSitemap: https://e.com/s.xml',
      ),
    ).toEqual({ disallow: ['/privado'], sitemaps: ['https://e.com/s.xml'] });
    expect(
      parseSitemap('<sitemapindex><sitemap><loc> https://e.com/a.xml </loc></sitemap></sitemapindex>'),
    ).toEqual({
      index: true,
      locs: ['https://e.com/a.xml'],
    });
    expect(parseSitemap('<urlset><url><loc>https://e.com/?a=1&amp;b=2</loc></url></urlset>').locs).toEqual([
      'https://e.com/?a=1&b=2',
    ]);
    expect(
      pageLinks(
        '<a href="/x">x</a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href=\'y\'>y</a><a href="javascript:void(0)">j</a>',
        'https://e.com/dir/page',
      ),
    ).toEqual(['https://e.com/x', 'https://e.com/dir/y']);
    expect(pageLinks('<base href="https://e.com/base/"><a href="z">z</a>', 'https://e.com/p')).toEqual([
      'https://e.com/base/z',
    ]);
  });

  it('follows the real address of the site, its sitemaps (indexes too) and its links, within the rules', async () => {
    const get = web(
      {
        'https://www.acme.com/': [
          200,
          H,
          html(
            'Início',
            '<a href="/sobre">s</a><a href="/blog/um">b</a><a href="https://outro.com/x">o</a><a href="/logo.png">l</a>',
          ),
        ],
        'https://www.acme.com/robots.txt': [
          200,
          'text/plain',
          'User-agent: *\nDisallow: /privado\nSitemap: https://www.acme.com/index.xml',
        ],
        'https://www.acme.com/index.xml': [
          200,
          'application/xml',
          '<sitemapindex><sitemap><loc>https://www.acme.com/pages.xml</loc></sitemap></sitemapindex>',
        ],
        'https://www.acme.com/pages.xml': [
          200,
          'application/xml',
          '<urlset><url><loc>https://www.acme.com/precos</loc></url><url><loc>https://www.acme.com/privado/a</loc></url><url><loc>https://outro.com/z</loc></url></urlset>',
        ],
        'https://www.acme.com/sobre': [200, H, html('Sobre', '<a href="/sobre/time">t</a>')],
        'https://www.acme.com/sobre/time': [200, H, html('Time', '<a href="/sobre/time/fundo">f</a>')],
        'https://www.acme.com/blog/um': [200, H, html('Post')],
        'https://www.acme.com/precos': [200, H, html('Preços')],
      },
      { 'http://acme.com/': 'https://www.acme.com/' },
    );
    const opts = { maxDepth: 2, maxPages: 50, include: [], exclude: ['/blog/*'], respectRobots: true };
    const pages = await discoverPages('http://acme.com/', opts, get);
    expect(pages).toEqual([
      { url: 'https://www.acme.com/', title: 'Início', via: 'start' },
      { url: 'https://www.acme.com/precos', title: '', via: 'sitemap' },
      { url: 'https://www.acme.com/sobre', title: 'Sobre', via: 'link' },
      { url: 'https://www.acme.com/sobre/time', title: 'Time', via: 'link' },
    ]);
    // Without robots the private page shows up; depth 0 keeps only what the sitemap lists.
    const all = await discoverPages('http://acme.com/', { ...opts, maxDepth: 0, respectRobots: false }, get);
    expect(all.map((p) => p.url)).toContain('https://www.acme.com/privado/a');
    expect(all.map((p) => p.url)).not.toContain('https://www.acme.com/sobre');
    expect(await discoverPages('http://acme.com/', { ...opts, maxPages: 2 }, get)).toHaveLength(2);
    await expect(discoverPages('nada', opts, get)).rejects.toThrow('URL inválida');
    await expect(discoverPages('https://fora.com/', opts, get)).rejects.toThrow('HTTP 404');
  });

  it('falls back to /sitemap.xml and survives broken pieces of a site', async () => {
    const pages = await discoverPages(
      'https://e.com',
      { maxDepth: 1, maxPages: 10, include: [], exclude: [], respectRobots: true },
      async (url): Promise<Fetched> => {
        if (url === 'https://e.com/')
          return {
            url,
            status: 200,
            headers: { 'content-type': H },
            body: html('E', '<a href="/quebrada">q</a><a href="/pdf">p</a>'),
          };
        if (url.endsWith('/robots.txt')) throw new Error('rede');
        if (url.endsWith('/sitemap.xml'))
          return {
            url,
            status: 200,
            headers: {},
            body: '<urlset><url><loc>https://e.com/mapa</loc></url></urlset>',
          };
        if (url.endsWith('/quebrada')) throw new Error('rede');
        return { url, status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF' };
      },
    );
    expect(pages.map((p) => p.url)).toEqual(['https://e.com/', 'https://e.com/mapa']);
  });
});

/** A watch page as YouTube serves it: the player JSON inside a script. */
const watchPage = (player: unknown) =>
  `<script>var x = 1;</script><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = {};</script>`;
const track = (languageCode: string, kind?: string) => ({
  baseUrl: `https://www.youtube.com/api/timedtext?v=abc&lang=${languageCode}`,
  languageCode,
  ...(kind ? { kind } : {}),
});
const json3 = JSON.stringify({
  events: [
    { tStartMs: 0, segs: [{ utf8: 'Olá ' }, { utf8: 'turma' }] },
    { tStartMs: 1500 },
    { tStartMs: 65_000, segs: [{ utf8: 'o preço\né 99' }] },
    { tStartMs: 130_000, segs: [{ utf8: 'segunda parte' }] },
  ],
});

describe('YouTube videos', () => {
  it('reads video and playlist ids from every kind of link', () => {
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ])
      expect(youTubeVideoId(link)).toBe('dQw4w9WgXcQ');
    expect(youTubeVideoId('https://vimeo.com/123')).toBeNull();
    expect(youTubeVideoId('https://youtube.com/watch?v=curto')).toBeNull();
    expect(youTubeVideoId('não é link')).toBeNull();
    expect(youTubePlaylistId('https://www.youtube.com/playlist?list=PLabcdefghij123')).toBe(
      'PLabcdefghij123',
    );
    expect(youTubePlaylistId('https://youtu.be/x?list=PLabcdefghij123')).toBeNull();
    expect(youTubePlaylistId('https://youtube.com/watch?v=x')).toBeNull();
    expect(youTubePlaylistId('lixo')).toBeNull();
  });

  it('finds the player JSON (strings with braces included) and picks the best captions', () => {
    expect(jsonAfter('var a = {"t":"}{\\"x","n":{"k":1}};', 'var a')).toEqual({ t: '}{"x', n: { k: 1 } });
    expect(jsonAfter('nada aqui', 'var a')).toBeNull();
    expect(jsonAfter('var a = ', 'var a')).toBeNull();
    expect(jsonAfter('var a = {"x": nope}', 'var a')).toBeNull();
    expect(jsonAfter('var a = {"x": 1', 'var a')).toBeNull();
    expect(pickTrack([track('fr'), track('en', 'asr'), track('es')])?.languageCode).toBe('es');
    expect(pickTrack([track('fr'), track('pt-BR', 'asr')])?.languageCode).toBe('fr');
    expect(pickTrack([track('en'), track('pt-BR')])?.languageCode).toBe('pt-BR');
    expect(pickTrack([])).toBeNull();
    expect(parseJson3('{oops')).toEqual([]);
    expect(parseJson3(json3)).toEqual([
      { start: 0, text: 'Olá turma' },
      { start: 65, text: 'o preço é 99' },
      { start: 130, text: 'segunda parte' },
    ]);
    expect([clock(5), clock(125), clock(3723)]).toEqual(['0:05', '2:05', '1:02:03']);
    expect([clockSeconds('2:05 – 4:05'), clockSeconds('1:02:03'), clockSeconds('x')]).toEqual([
      125,
      3723,
      null,
    ]);
  });

  it('turns captions into timed blocks whose pieces link to their moment', async () => {
    const player = {
      playabilityStatus: { status: 'OK' },
      videoDetails: { title: 'Aula 1', author: 'Canal', lengthSeconds: '200' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [track('en'), track('pt', 'asr')] } },
    };
    const get = web({
      'https://www.youtube.com/watch?v=abcdefghijk&hl=pt-BR&persist_hl=1': [200, H, watchPage(player)],
      [`${track('en').baseUrl}&fmt=json3`]: [200, 'application/json', json3],
    });
    const t = await fetchTranscript('abcdefghijk', get);
    expect(t).toMatchObject({ title: 'Aula 1', channel: 'Canal', seconds: 200, language: 'en', auto: false });
    const text = transcriptText(t);
    expect(text).toBe(
      '# Aula 1\n\n## 0:00 – 2:00\n\nOlá turma o preço é 99\n\n## 2:00 – 4:00\n\nsegunda parte\n',
    );
    const pieces = chunkText(text, 1200, 0);
    expect(pieces.map((p) => momentUrl('abcdefghijk', p.section))).toEqual([
      'https://www.youtube.com/watch?v=abcdefghijk',
      'https://www.youtube.com/watch?v=abcdefghijk&t=120s',
    ]);
    expect(transcriptText({ ...t, title: '', segments: [] })).toBe('# abcdefghijk\n');
  });

  it("asks the app player for fresh caption links and reads YouTube's XML captions", async () => {
    const calls: { url: string; body?: string }[] = [];
    const appTrack = {
      baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=pt&fmt=srv3',
      languageCode: 'pt',
    };
    const get: Get = async (url, init): Promise<Fetched> => {
      calls.push({ url, body: init?.body });
      if (url.startsWith('https://www.youtube.com/watch'))
        return {
          url,
          status: 200,
          headers: { 'content-type': H },
          body: `<script>ytcfg.set({"INNERTUBE_API_KEY":"AIzaTest_123"});</script>${watchPage({
            playabilityStatus: { status: 'OK' },
            videoDetails: { title: 'Título da página' },
          })}`,
        };
      if (url.startsWith('https://www.youtube.com/youtubei/v1/player?key=AIzaTest_123'))
        return {
          url,
          status: 200,
          headers: {},
          body: JSON.stringify({
            playabilityStatus: { status: 'OK' },
            videoDetails: { title: 'Título do app', author: 'Canal', lengthSeconds: '90' },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [appTrack] } },
          }),
        };
      if (url === 'https://www.youtube.com/api/timedtext?v=abc&lang=pt')
        return {
          url,
          status: 200,
          headers: {},
          body: '<?xml version="1.0"?><transcript><text start="0.5" dur="2">Ol&amp;#225; &lt;b&gt;turma&lt;/b&gt;</text><text start="130.2">fim</text><text start="3"> </text></transcript>',
        };
      return { url, status: 404, headers: {}, body: '' };
    };
    const t = await fetchTranscript('abcdefghijk', get);
    expect(t).toMatchObject({ title: 'Título da página', channel: 'Canal', seconds: 90, language: 'pt' });
    expect(t.segments).toEqual([
      { start: 0, text: 'Olá turma' },
      { start: 130, text: 'fim' },
    ]);
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({
      videoId: 'abcdefghijk',
      context: { client: { clientName: 'ANDROID' } },
    });
    expect(
      parseXmlCaptions('<timedtext><body><p t="61500" d="900">um <s>dois</s></p></body></timedtext>'),
    ).toEqual([{ start: 61, text: 'um dois' }]);
  });

  it('explains why a video cannot be read', async () => {
    const page = (player: unknown) =>
      web({
        'https://www.youtube.com/watch?v=abcdefghijk&hl=pt-BR&persist_hl=1': [200, H, watchPage(player)],
      });
    await expect(fetchTranscript('abcdefghijk', web({}))).rejects.toThrow('HTTP 404');
    await expect(
      fetchTranscript(
        'abcdefghijk',
        page({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Vídeo privado' } }),
      ),
    ).rejects.toThrow('Vídeo privado');
    await expect(fetchTranscript('abcdefghijk', page({}))).rejects.toThrow('não liberou');
    await expect(
      fetchTranscript('abcdefghijk', page({ playabilityStatus: { status: 'OK' } })),
    ).rejects.toThrow('não tem legendas');
    await expect(
      fetchTranscript(
        'abcdefghijk',
        page({
          playabilityStatus: { status: 'OK' },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [track('pt')] } },
        }),
      ),
    ).rejects.toThrow('não entregou');
  });

  it('lists the videos of a playlist once each', async () => {
    const item = (id: string, title: string) =>
      `"playlistVideoRenderer":{"videoId":"${id}","thumbnail":{},"title":{"runs":[{"text":"${title}"}]}}`;
    const body = `<script>var ytInitialData = {${item('aaaaaaaaaaa', 'Aula \\"1\\"')},${item('bbbbbbbbbbb', 'Aula 2')},${item('aaaaaaaaaaa', 'Aula 1')}};</script>`;
    const get = web({ 'https://www.youtube.com/playlist?list=PL123456789&hl=pt-BR': [200, H, body] });
    expect(await playlistVideos('PL123456789', get)).toEqual([
      { id: 'aaaaaaaaaaa', title: 'Aula "1"' },
      { id: 'bbbbbbbbbbb', title: 'Aula 2' },
    ]);
    await expect(playlistVideos('PLnope', web({}))).rejects.toThrow('HTTP 404');
  });
});

describe('spreadsheets and slide decks', () => {
  it('turns sheets into Markdown tables (shared strings, gaps and names included)', async () => {
    const zip = new JSZip();
    zip.file(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="Preços &amp; planos" sheetId="1"/><sheet name="Vazia" sheetId="2"/></sheets></workbook>',
    );
    zip.file(
      'xl/sharedStrings.xml',
      '<sst><si><t>Plano</t></si><si><t>Valor</t></si><si><r><t>Pro</t></r><r><t> anual</t></r></si></sst>',
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>990</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Básico | mensal</t></is></c><c r="B3"/></row>' +
        '<row r="4"></row>' +
        '</sheetData></worksheet>',
    );
    zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>');
    const text = await xlsxToText(await zip.generateAsync({ type: 'uint8array' }));
    expect(text).toBe(
      '# Preços & planos\n\n| Plano | Valor |  |\n| --- | --- | --- |\n| Pro anual |  | 990 |\n| Básico / mensal |  |  |\n',
    );
    const pieces = chunkText(text, 1200, 0);
    expect(pieces[0].content).toContain('Plano: Pro anual');
  });

  it('turns each slide into a section with its notes', async () => {
    const zip = new JSZip();
    const slide = (...paras: string[]) =>
      `<p:sld><p:cSld>${paras.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')}<a:p></a:p></p:cSld></p:sld>`;
    zip.file('ppt/slides/slide10.xml', slide('Fim'));
    zip.file('ppt/slides/slide1.xml', slide('Abertura', 'Bem-vindos &amp; boas-vindas &#233; &#x41;'));
    zip.file('ppt/slides/slide2.xml', '<p:sld></p:sld>');
    zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><a:t>Falar</a:t><a:t>devagar</a:t></p:notes>');
    expect(await pptxToText(await zip.generateAsync({ type: 'uint8array' }))).toBe(
      '# 1. Abertura\n\nBem-vindos & boas-vindas é A\n\nFalar devagar\n\n# 3. Fim\n\n',
    );
  });
});

describe('rerankers', () => {
  it('sends the Cohere/Jina/Voyage request and reads either answer shape back in order', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer = (body: unknown, status = 200): typeof fetch =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const config = { baseUrl: 'https://api.cohere.com/v2/', apiKey: 'co-key', model: 'rerank-v3.5' };
    const cohere = httpReranker(
      config,
      answer({
        results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }, { index: 7 }],
      }),
    );
    expect(await cohere('preço', ['a', 'b'])).toEqual([0.2, 0.9]);
    expect(calls[0].url).toBe('https://api.cohere.com/v2/rerank');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'rerank-v3.5',
      query: 'preço',
      documents: ['a', 'b'],
      top_n: 2,
    });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer co-key');
    const voyage = httpReranker(config, answer({ data: [{ index: 0, relevance_score: 0.5 }] }));
    expect(await voyage('q', ['a', 'b'])).toEqual([0.5, 0]);
    expect(await httpReranker(config, answer(null))('q', ['a'])).toEqual([0]);
    expect(await cohere('q', [])).toEqual([]);
    await expect(httpReranker(config, answer({}, 401))('q', ['a'])).rejects.toThrow('401');
  });
});

describe('knowledge settings and inputs', () => {
  it('accepts sane settings and refuses the rest', () => {
    expect(
      knowledgeBaseSettings.parse({ chunkSize: 800, retrievalMode: 'semantic', rerankIntegrationId: null }),
    ).toEqual({
      chunkSize: 800,
      retrievalMode: 'semantic',
      rerankIntegrationId: null,
    });
    for (const bad of [
      { chunkSize: 50 },
      { topK: 0 },
      { minScore: 2 },
      { retrievalMode: 'magic' },
      { chunkOverlap: -1 },
    ])
      expect(knowledgeBaseSettings.safeParse(bad).success).toBe(false);
    expect(knowledgeChunkPatch.safeParse({}).success).toBe(false);
    expect(knowledgeChunkPatch.parse({ enabled: false })).toEqual({ enabled: false });
    expect(knowledgeSourceUpdate.safeParse({ pairs: [] }).success).toBe(false);
    expect(knowledgeSourceUpdate.parse({ pairs: [{ question: 'P?', answer: 'R' }] }).pairs?.[0].active).toBe(
      true,
    );
  });

  it('describes videos, links and websites', () => {
    expect(knowledgeSourceInput.parse({ kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' })).toEqual({
      kind: 'youtube',
      url: 'https://youtu.be/dQw4w9WgXcQ',
      title: '',
      playlist: false,
      syncInterval: 'off',
    });
    expect(
      knowledgeSourceInput.parse({ kind: 'url', url: 'https://e.com', syncInterval: 'daily' }),
    ).toMatchObject({
      syncInterval: 'daily',
    });
    expect(knowledgeSourceInput.safeParse({ kind: 'url', url: 'ftp://e.com' }).success).toBe(false);
    expect(knowledgeCrawlInput.parse({ url: 'https://e.com' })).toEqual({
      url: 'https://e.com',
      maxDepth: 2,
      include: [],
      exclude: [],
      respectRobots: true,
    });
    expect(knowledgeCrawlInput.safeParse({ url: 'https://e.com', maxDepth: 9 }).success).toBe(false);
    expect(knowledgeWebsiteInput.safeParse({ url: 'https://e.com', pages: [] }).success).toBe(false);
    expect(
      knowledgeWebsiteInput.safeParse({
        url: 'https://e.com',
        pages: Array.from({ length: 101 }, (_, i) => `https://e.com/${i}`),
      }).success,
    ).toBe(false);
  });
});
