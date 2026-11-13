import type { Locale } from '@/i18n/config';

/** Speech recognition and synthesis tags for each interface language. */
export const SPEECH_LANG: Record<Locale, string> = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-ES' };

export const MAX_NAME_LENGTH = 80;

/** How people introduce themselves before saying the name, in the three languages. */
const LEAD_INS = [
  /^(?:o\s+)?meu\s+nome\s+(?:é|e)(?:\s+|$)/,
  /^eu\s+(?:me\s+chamo|sou\s+(?:o|a)?)(?:\s+|$)/,
  /^me\s+chamo(?:\s+|$)/,
  /^(?:eu\s+)?sou(?:\s+(?:o|a))?(?:\s+|$)/,
  /^(?:hi,?\s+)?my\s+name\s+is(?:\s+|$)/,
  /^(?:hi,?\s+)?(?:i\s+am|i'm|this\s+is)(?:\s+|$)/,
  /^(?:hola,?\s+)?(?:mi\s+nombre\s+es|me\s+llamo|soy)(?:\s+|$)/,
];

/** Words that keep their lower case inside a name ("Maria da Silva", "Juan de la Cruz"). */
const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'la', 'del', 'y', 'van', 'von']);

/**
 * The name in what someone said ("meu nome é ana souza" → "Ana Souza"). It is only a proposal:
 * the person still confirms or corrects it before it is used.
 */
export function spokenName(transcript: string): string {
  let text = transcript.normalize('NFC').trim().toLowerCase();
  for (const lead of LEAD_INS) text = text.replace(lead, '');
  const words = text
    .replace(/[.,!?;:"“”]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w, i) => (i > 0 && PARTICLES.has(w) ? w : w.charAt(0).toLocaleUpperCase() + w.slice(1)))
    .join(' ')
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** Spoken commands that mean "let me in now", in the three languages. */
const JOIN_WORDS = /\b(entrar|entra|participar|enter|join|unirme|unir|entrar\s+na\s+sala)\b/;

export function isJoinCommand(transcript: string): boolean {
  return JOIN_WORDS.test(transcript.toLowerCase());
}

/** Whether the room link asked for the assisted entry ("?assist=1" or "?ajuda=1"). */
export function wantsAssistance(search: string): boolean {
  const params = new URLSearchParams(search);
  return ['assist', 'ajuda', 'ayuda'].some((k) =>
    ['1', 'true', 'sim', 'si', 'yes'].includes(params.get(k) ?? ''),
  );
}
