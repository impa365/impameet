/**
 * YouTube videos as knowledge: the captions of the video (made by people when there are, the
 * automatic ones otherwise), cut in two-minute blocks whose headings carry the time, so an
 * answer can point to the exact moment. Playlists add each of their videos.
 */
import type { Get } from './crawl';

export interface Segment {
  /** Seconds from the start. */
  start: number;
  text: string;
}

export interface Transcript {
  videoId: string;
  title: string;
  channel: string;
  seconds: number;
  language: string;
  /** Automatic captions (speech recognition by YouTube). */
  auto: boolean;
  segments: Segment[];
}

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

const LANGUAGES = ['pt', 'en', 'es'];
const BLOCK_SECONDS = 120;

export function youTubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  const id =
    host === 'youtu.be'
      ? url.pathname.slice(1)
      : host === 'youtube.com' || host === 'youtube-nocookie.com'
        ? (url.searchParams.get('v') ?? /^\/(?:shorts|embed|live|v)\/([^/?]+)/.exec(url.pathname)?.[1] ?? '')
        : '';
  return /^[\w-]{11}$/.test(id) ? id : null;
}

export function youTubePlaylistId(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
    const id = url.searchParams.get('list') ?? '';
    return /^[\w-]{10,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The JSON object assigned after `marker` in a page script (strings and nesting respected). */
export function jsonAfter(html: string, marker: string): unknown {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

type Player = {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
};

export function playerInfo(html: string) {
  const player = (jsonAfter(html, 'ytInitialPlayerResponse') ?? {}) as Player;
  return {
    status: player.playabilityStatus?.status ?? 'UNKNOWN',
    reason: player.playabilityStatus?.reason ?? '',
    title: player.videoDetails?.title ?? '',
    channel: player.videoDetails?.author ?? '',
    seconds: Number(player.videoDetails?.lengthSeconds ?? 0) || 0,
    tracks: player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
  };
}

/** Captions made by people before automatic ones, in Portuguese, English, Spanish, then any. */
export function pickTrack(tracks: Track[]): Track | null {
  const lang = (t: Track) => t.languageCode.toLowerCase().split('-')[0];
  const rank = (t: Track) => {
    const i = LANGUAGES.indexOf(lang(t));
    return (t.kind === 'asr' ? 10 : 0) + (i < 0 ? LANGUAGES.length : i);
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** YouTube's json3 caption format. */
export function parseJson3(body: string): Segment[] {
  let data: { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  return (data.events ?? [])
    .map((e) => ({
      start: Math.floor((e.tStartMs ?? 0) / 1000),
      text: (e.segs ?? [])
        .map((s) => s.utf8 ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((s) => s.text);
}

export const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** "1:02:03" or "4:05" back to seconds. */
export function clockSeconds(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** The transcript as Markdown: one heading per two-minute block, with its time. */
export function transcriptText(t: Transcript): string {
  const blocks = new Map<number, string[]>();
  for (const s of t.segments) {
    const block = Math.floor(s.start / BLOCK_SECONDS) * BLOCK_SECONDS;
    blocks.set(block, [...(blocks.get(block) ?? []), s.text]);
  }
  const out = [`# ${t.title || t.videoId}`, ''];
  for (const [start, lines] of [...blocks.entries()].sort((a, b) => a[0] - b[0]))
    out.push(`## ${clock(start)} – ${clock(start + BLOCK_SECONDS)}`, '', lines.join(' '), '');
  return out.join('\n');
}

/** The link to a moment of the video, from a piece's heading ("Title > 2:00 – 4:00"). */
export function momentUrl(videoId: string, section: string): string {
  const time = section.split(' > ').pop() ?? '';
  const seconds = clockSeconds(time);
  return `https://www.youtube.com/watch?v=${videoId}${seconds ? `&t=${seconds}s` : ''}`;
}

export async function fetchTranscript(videoId: string, get: Get): Promise<Transcript> {
  const page = await get(`https://www.youtube.com/watch?v=${videoId}&hl=pt-BR&persist_hl=1`);
  if (page.status !== 200) throw new Error(`O YouTube respondeu HTTP ${page.status}`);
  const info = playerInfo(page.body);
  if (info.status !== 'OK')
    throw new Error(
      info.reason ? `O YouTube não liberou o vídeo: ${info.reason}` : 'O YouTube não liberou o vídeo',
    );
  const track = pickTrack(info.tracks);
  if (!track) throw new Error('O vídeo não tem legendas (nem automáticas)');
  const captions = await get(`${track.baseUrl}&fmt=json3`);
  const segments = captions.status === 200 ? parseJson3(captions.body) : [];
  if (segments.length === 0) throw new Error('O YouTube não entregou a legenda do vídeo');
  return {
    videoId,
    title: info.title,
    channel: info.channel,
    seconds: info.seconds,
    language: track.languageCode,
    auto: track.kind === 'asr',
    segments,
  };
}

/** The videos of a playlist (the first page, up to 100). */
export async function playlistVideos(listId: string, get: Get): Promise<{ id: string; title: string }[]> {
  const page = await get(`https://www.youtube.com/playlist?list=${listId}&hl=pt-BR`);
  if (page.status !== 200) throw new Error(`O YouTube respondeu HTTP ${page.status}`);
  const out = new Map<string, string>();
  for (const m of page.body.matchAll(
    /"playlistVideoRenderer":\{"videoId":"([\w-]{11})"[\s\S]*?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g,
  )) {
    if (out.size >= 100) break;
    if (!out.has(m[1])) out.set(m[1], JSON.parse(`"${m[2]}"`) as string);
  }
  return [...out.entries()].map(([id, title]) => ({ id, title }));
}
