export const CAPTIONS_TOPIC = 'impa.captions';
export const CAPTIONER_ATTRIBUTE = 'impa.mode';
export const CAPTION_TTL_MS = 8000;
export const MAX_CAPTIONS = 3;

export interface Caption {
  id: string;
  identity: string;
  name: string;
  text: string;
  final: boolean;
  at: number;
}

export function parseCaption(raw: string, now: number): Caption | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const c = data as Record<string, unknown>;
  const ok =
    typeof c.id === 'string' &&
    typeof c.identity === 'string' &&
    typeof c.name === 'string' &&
    typeof c.text === 'string' &&
    typeof c.final === 'boolean' &&
    c.text.length > 0 &&
    c.text.length <= 5000;
  if (!ok) return null;
  return {
    id: c.id as string,
    identity: c.identity as string,
    name: (c.name as string).slice(0, 80),
    text: c.text as string,
    final: c.final as boolean,
    at: now,
  };
}

/** Interim results replace their segment in place; old lines fade out. */
export function addCaption(list: readonly Caption[], next: Caption): Caption[] {
  const fresh = list.filter((c) => c.id !== next.id && next.at - c.at < CAPTION_TTL_MS);
  return [...fresh, next].slice(-MAX_CAPTIONS);
}

export function visibleCaptions(list: readonly Caption[], now: number): Caption[] {
  return list.filter((c) => now - c.at < CAPTION_TTL_MS);
}
