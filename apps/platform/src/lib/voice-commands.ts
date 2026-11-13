/**
 * Plain rules for short spoken answers and media commands, in Portuguese, English and Spanish.
 * No model: the same words always mean the same thing, and anything ambiguous (both "on" and
 * "off", a negation next to a verb, no device) is refused instead of guessed. Callers ask again.
 */

/** Lower case, no accents, punctuation as spaces: the form every rule below reads. */
export function normalizeSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole words or phrases only: " liga " matches "liga", never "desliga". */
const words = (list: string[]) => new RegExp(`\\s(?:${list.join('|')})\\s`);
const test = (re: RegExp, text: string) => re.test(` ${text} `);

const YES = words([
  'sim',
  'isso',
  'correto',
  'certo',
  'exato',
  'exatamente',
  'confirmo',
  'confirmar',
  'confirma',
  'pode confirmar',
  'pode sim',
  'claro',
  'yes',
  'yeah',
  'yep',
  'correct',
  'right',
  'confirm',
  'sure',
  'si',
  'correcto',
  'eso',
  'exacto',
]);
const NO = words([
  'nao',
  'errado',
  'errada',
  'incorreto',
  'corrigir',
  'corrige',
  'no',
  'nope',
  'not',
  'wrong',
  'incorrect',
  'incorrecto',
  'equivocado',
  'mal',
  'corregir',
]);
/** "Não está correto", "that's not right", "no es correcto": a no, even with a yes word in it. */
const NEGATED_YES = words([
  'nao (?:esta |e )?(?:correto|certo|isso)',
  'not (?:correct|right)',
  'isn t (?:correct|right)',
  'no (?:es |esta )?(?:correcto|eso)',
]);
const REPEAT = words([
  'repetir',
  'repete',
  'repita',
  'de novo',
  'outra vez',
  'repeat',
  'again',
  'otra vez',
  'repite',
]);

export type YesNo = 'yes' | 'no' | 'repeat' | null;

/** A confirmation: yes, no, "say it again", or null when it is not clear. */
export function parseYesNo(transcript: string): YesNo {
  const text = normalizeSpeech(transcript);
  if (!text) return null;
  if (test(NEGATED_YES, text)) return 'no';
  const yes = test(YES, text);
  const no = test(NO, text);
  if (yes && no) return null;
  if (yes) return 'yes';
  if (no) return 'no';
  return test(REPEAT, text) ? 'repeat' : null;
}

const ON = words([
  'liga',
  'ligar',
  'ligado',
  'ligada',
  'ligue',
  'ativa',
  'ativar',
  'ativado',
  'ativada',
  'abre',
  'abrir',
  'turn on',
  'switch on',
  'on',
  'enable',
  'unmute',
  'enciende',
  'encender',
  'encendido',
  'encendida',
  'activa',
  'activar',
  'activado',
  'activada',
  'prende',
  'prender',
]);
const OFF = words([
  'desliga',
  'desligar',
  'desligado',
  'desligada',
  'desligue',
  'desativa',
  'desativar',
  'desativado',
  'desativada',
  'fecha',
  'fechar',
  'muta',
  'mutar',
  'mudo',
  'silencia',
  'silenciar',
  'turn off',
  'switch off',
  'off',
  'disable',
  'mute',
  'apaga',
  'apagar',
  'apagado',
  'apagada',
  'desactiva',
  'desactivar',
  'desactivado',
  'desactivada',
]);
const KEEP = words([
  'manter',
  'mantem',
  'mantenha',
  'mantenho',
  'deixa',
  'deixar',
  'deixe',
  'assim mesmo',
  'como esta',
  'keep',
  'leave',
  'as is',
  'mantener',
  'manten',
  'mantenlo',
  'dejar',
  'deja',
  'dejalo',
  'asi',
]);
const NEGATION = words(['nao', 'no', 'not', 'dont', 'don t', 'nunca', 'never']);

/**
 * The answer to "keep your microphone on, or turn it off?": the state wanted, or null when it
 * is not clear (both verbs, a negation next to a verb, nothing that fits). "Keep" keeps `current`.
 */
export function parseDeviceAnswer(transcript: string, current: boolean): boolean | null {
  const text = normalizeSpeech(transcript);
  const on = test(ON, text);
  const off = test(OFF, text);
  if (on && off) return null;
  if ((on || off) && test(NEGATION, text)) return null;
  if (on) return true;
  if (off) return false;
  return test(KEEP, text) ? current : null;
}

export type MediaDevice = 'microphone' | 'camera';

export type VoiceCommand =
  | { kind: 'set'; devices: MediaDevice[]; on: boolean }
  | { kind: 'status'; devices: MediaDevice[] }
  | { kind: 'join' }
  | { kind: 'repeat' }
  | { kind: 'unknown' };

const MIC = words(['microfone', 'micro', 'mic', 'microphone', 'microfono', 'audio', 'som', 'voz']);
const CAM = words(['camera', 'cam', 'webcam', 'video', 'camara']);
const STATUS = words(['estado', 'status', 'state', 'qual', 'cual', 'como', 'is', 'esta', 'how']);
const JOIN = words(['entra', 'entrar', 'entre', 'join', 'enter', 'entra na sala', 'unirme', 'unete']);
const LEADING = /^(?:(?:ok|oi|ola|ei|hey|hi|hola|e ai)\s+)+/;

export const DEFAULT_WAKE_WORD = 'Star';
export const MAX_WAKE_WORD = 30;

/** How speech engines tend to write the default name in Portuguese and Spanish. */
const WAKE_ALIASES: Record<string, string[]> = { star: ['star', 'estar', 'istar', 'stars', 'esta star'] };

/** The wake word as the rules compare it (empty when unusable). */
export function wakeKey(wakeWord: string): string {
  return normalizeSpeech(wakeWord).slice(0, MAX_WAKE_WORD);
}

/**
 * A command for the local assistant: only when the phrase starts with its name ("Star, desliga
 * meu microfone"), so ordinary conversation never moves a device. Null when not addressed.
 */
export function parseVoiceCommand(transcript: string, wakeWord: string): VoiceCommand | null {
  const key = wakeKey(wakeWord);
  if (!key) return null;
  const text = normalizeSpeech(transcript).replace(LEADING, '');
  const name = [key, ...(WAKE_ALIASES[key] ?? [])]
    .sort((a, b) => b.length - a.length)
    .find((w) => text === w || text.startsWith(`${w} `));
  if (!name) return null;
  const rest = text.slice(name.length).trim();
  const devices: MediaDevice[] = [
    ...(test(MIC, rest) ? (['microphone'] as const) : []),
    ...(test(CAM, rest) ? (['camera'] as const) : []),
  ];
  if (test(REPEAT, rest) && devices.length === 0) return { kind: 'repeat' };
  if (devices.length === 0) return test(JOIN, rest) ? { kind: 'join' } : { kind: 'unknown' };
  if (test(STATUS, rest)) return { kind: 'status', devices };
  const on = test(ON, rest);
  const off = test(OFF, rest);
  if (on === off || test(NEGATION, rest)) return { kind: 'unknown' };
  return { kind: 'set', devices, on };
}
