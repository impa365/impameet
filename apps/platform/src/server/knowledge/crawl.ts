/**
 * Finding the pages of a website to import: its sitemaps first (robots.txt, /sitemap.xml and
 * sitemap indexes), then the links of the pages themselves, breadth first, never leaving the
 * site. Every request goes through the outbound guard (public https only, no redirects).
 */
import { htmlToText } from './text';

export interface Fetched {
  /** The address that answered, after any redirects. */
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Get = (url: string) => Promise<Fetched>;

export interface CrawlOptions {
  /** How many links away from the start page (1 = only the pages it links to). */
  maxDepth: number;
  /** Pages to list at most (the admin then picks which to import). */
  maxPages: number;
  /** Path patterns with * wildcards, e.g. "/blog/*". Empty means everything. */
  include: string[];
  exclude: string[];
  respectRobots: boolean;
}

export interface FoundPage {
  url: string;
  title: string;
  /** Where it was found. */
  via: 'sitemap' | 'link' | 'start';
}

const MAX_SITEMAPS = 10;
/** Pages fetched while following links (sitemaps can list more without fetching them). */
const MAX_FETCHES = 60;
const SKIP_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|mjs|json|xml|zip|gz|rar|7z|mp3|mp4|mov|avi|webm|woff2?|ttf|eot|exe|dmg|docx?|xlsx?|pptx?)$/i;

/** "/blog/*" → /^\/blog\/.*$/ (only * is special). */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function pathAllowed(path: string, include: string[], exclude: string[]): boolean {
  const inc = include.filter((g) => g.trim());
  const exc = exclude.filter((g) => g.trim());
  if (inc.length > 0 && !inc.some((g) => globToRegExp(g).test(path))) return false;
  return !exc.some((g) => globToRegExp(g).test(path));
}

/** The same page however it was written: no fragment, no trailing slash, host lowercased. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
  let s = url.toString();
  if (url.pathname !== '/' && s.endsWith('/') && !url.search) s = s.slice(0, -1);
  return s;
}

/** Disallow rules that apply to every crawler ("User-agent: *"). */
export function robotsRules(txt: string): { disallow: string[]; sitemaps: string[] } {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  let applies = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const key = field?.toLowerCase();
    if (key === 'user-agent') applies = value === '*';
    else if (key === 'disallow' && applies && value) disallow.push(value);
    else if (key === 'sitemap' && value) sitemaps.push(value);
  }
  return { disallow, sitemaps };
}

const blockedByRobots = (path: string, disallow: string[]) =>
  disallow.some((rule) => (rule.includes('*') ? globToRegExp(`${rule}*`).test(path) : path.startsWith(rule)));

/** <loc> entries of a sitemap, and whether it is an index of other sitemaps. */
export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) =>
    m[1].replace(/&amp;/g, '&').trim(),
  );
  return { index: /<sitemapindex\b/i.test(xml), locs };
}

/** The links of a page, resolved against it. */
export function pageLinks(html: string, pageUrl: string): string[] {
  const base = /<base\b[^>]*href="([^"]+)"/i.exec(html)?.[1] ?? pageUrl;
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    if (/^(mailto|tel|javascript):/i.test(m[1])) continue;
    const url = normalizeUrl(m[1], base);
    if (url) out.push(url);
  }
  return out;
}

const isHtml = (res: Fetched) => (res.headers['content-type'] ?? '').includes('html');

/** The pages of a site the admin can choose from. */
export async function discoverPages(start: string, opts: CrawlOptions, get: Get): Promise<FoundPage[]> {
  const first = normalizeUrl(start);
  if (!first) throw new Error('URL inválida');
  // The start page decides where the site really is (http → https, example.com → www...).
  const home = await get(first);
  if (home.status !== 200) throw new Error(`O site respondeu HTTP ${home.status}`);
  const root = normalizeUrl(home.url) ?? first;
  const { origin, host } = new URL(root);
  const sameSite = (u: string) => new URL(u).host === host;
  let disallow: string[] = [];
  const allowed = (u: string) => {
    const url = new URL(u);
    return (
      sameSite(u) &&
      !SKIP_EXTENSIONS.test(url.pathname) &&
      pathAllowed(url.pathname, opts.include, opts.exclude) &&
      !(opts.respectRobots && blockedByRobots(url.pathname + url.search, disallow))
    );
  };
  const found = new Map<string, FoundPage>();
  const add = (url: string, via: FoundPage['via'], title = '') => {
    const existing = found.get(url);
    if (existing) {
      existing.title ||= title;
      return;
    }
    if (found.size < opts.maxPages && allowed(url)) found.set(url, { url, title, via });
  };

  const sitemapQueue: string[] = [];
  try {
    const robots = await get(`${origin}/robots.txt`);
    if (robots.status === 200) {
      const rules = robotsRules(robots.body);
      disallow = rules.disallow;
      sitemapQueue.push(...rules.sitemaps);
    }
  } catch {
    // No robots.txt is fine.
  }
  if (sitemapQueue.length === 0) sitemapQueue.push(`${origin}/sitemap.xml`);
  if (isHtml(home)) add(root, 'start', htmlToText(home.body).title);

  let sitemaps = 0;
  while (sitemapQueue.length > 0 && sitemaps < MAX_SITEMAPS && found.size < opts.maxPages) {
    const next = sitemapQueue.shift()!;
    sitemaps += 1;
    try {
      const res = await get(next);
      if (res.status !== 200) continue;
      const { index, locs } = parseSitemap(res.body);
      for (const loc of locs) {
        const url = normalizeUrl(loc);
        if (!url || !sameSite(url)) continue;
        if (index) sitemapQueue.push(url);
        else add(url, 'sitemap');
      }
    } catch {
      // A broken sitemap only means fewer pages from it.
    }
  }

  // Links, breadth first from the start page (already fetched).
  const queue: { url: string; depth: number; page?: Fetched }[] = [{ url: root, depth: 0, page: home }];
  const visited = new Set<string>();
  let fetches = 0;
  while (queue.length > 0 && fetches < MAX_FETCHES && found.size < opts.maxPages) {
    const { url, depth, page } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (url !== root && !allowed(url)) continue;
    let res = page;
    if (!res) {
      fetches += 1;
      try {
        res = await get(url);
      } catch {
        continue;
      }
    }
    if (res.status !== 200 || !isHtml(res)) continue;
    if (url !== root) add(url, 'link', htmlToText(res.body).title);
    if (depth >= opts.maxDepth) continue;
    for (const link of pageLinks(res.body, res.url || url))
      if (!visited.has(link) && sameSite(link)) queue.push({ url: link, depth: depth + 1 });
  }
  return [...found.values()];
}
