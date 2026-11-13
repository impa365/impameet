import type { MessageKey } from '@/i18n/keys';
import { BOARD_ANNOUNCE, type BoardAnnounce } from './board-text';
import { DEFAULT_WAKE_WORD, MAX_WAKE_WORD, wakeKey } from './voice-commands';

/** Theme of the call's side panels and dialogs; the call itself stays dark. */
export const PANEL_THEMES = ['system', 'light', 'dark'] as const;
export type PanelTheme = (typeof PANEL_THEMES)[number];

/** What the call says out loud to screen readers, which sounds it plays and how it looks. */
export interface A11yPrefs {
  announceJoins: boolean;
  announceChat: boolean;
  announceActivity: boolean;
  sounds: boolean;
  largeCaptions: boolean;
  panelTheme: PanelTheme;
  /** Whiteboard changes read out: every burst, a summary at most every 30 s, or never. */
  boardAnnounce: BoardAnnounce;
  /** The local voice assistant listens during the call (only once the person turns it on). */
  voiceCommands: boolean;
  /** Its name, said before each command ("Star, desliga meu microfone"). */
  wakeWord: string;
}

/** The call's own look, used when the system does not say which it prefers. */
export const CALL_THEME = 'dark';

/**
 * Explicit choice first, then the system preference (prefers-color-scheme), then the call's
 * dark look. systemDark is null when the browser does not tell.
 */
export function resolvePanelTheme(choice: PanelTheme, systemDark: boolean | null): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  if (systemDark === null) return CALL_THEME;
  return systemDark ? 'dark' : 'light';
}

export const DEFAULT_A11Y: A11yPrefs = {
  announceJoins: true,
  announceChat: true,
  announceActivity: true,
  sounds: true,
  largeCaptions: false,
  panelTheme: 'system',
  boardAnnounce: 'summary',
  voiceCommands: false,
  wakeWord: DEFAULT_WAKE_WORD,
};

export const A11Y_STORAGE_KEY = 'impa-a11y';

export function parseA11yPrefs(raw: string | null): A11yPrefs {
  if (!raw) return DEFAULT_A11Y;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: Exclude<keyof A11yPrefs, 'panelTheme' | 'boardAnnounce' | 'wakeWord'>) =>
      typeof data[k] === 'boolean' ? (data[k] as boolean) : DEFAULT_A11Y[k];
    const wake = typeof data.wakeWord === 'string' ? data.wakeWord.trim().slice(0, MAX_WAKE_WORD) : '';
    const theme = (PANEL_THEMES as readonly unknown[]).includes(data.panelTheme)
      ? (data.panelTheme as PanelTheme)
      : DEFAULT_A11Y.panelTheme;
    return {
      announceJoins: pick('announceJoins'),
      announceChat: pick('announceChat'),
      announceActivity: pick('announceActivity'),
      sounds: pick('sounds'),
      largeCaptions: pick('largeCaptions'),
      panelTheme: theme,
      boardAnnounce: (BOARD_ANNOUNCE as readonly unknown[]).includes(data.boardAnnounce)
        ? (data.boardAnnounce as BoardAnnounce)
        : DEFAULT_A11Y.boardAnnounce,
      voiceCommands: pick('voiceCommands'),
      wakeWord: wakeKey(wake) ? wake : DEFAULT_A11Y.wakeWord,
    };
  } catch {
    return DEFAULT_A11Y;
  }
}

export const SHORTCUTS: [string, MessageKey][] = [
  ['Ctrl + D', 'room.shortcuts.mic'],
  ['Ctrl + E', 'room.shortcuts.camera'],
  ['Ctrl + Alt + H', 'room.shortcuts.hand'],
  ['Ctrl + Alt + C', 'room.shortcuts.chat'],
  ['Ctrl + Alt + P', 'room.shortcuts.people'],
  ['Ctrl + Alt + A', 'room.shortcuts.activities'],
  ['Ctrl + Alt + S', 'room.shortcuts.speaking'],
  ['Ctrl + Alt + R', 'room.shortcuts.summary'],
  ['Shift + ?', 'room.shortcuts.help'],
  ['Esc', 'room.shortcuts.closePanel'],
];

/** Agents that joined before they carried a name show as "agent-AJ_…"; never show that. */
export function displayName(
  p: { name?: string; identity: string; isAgent: boolean },
  agentLabel = 'Assistente de IA',
): string {
  if (p.name && !(p.isAgent && /^agent-/.test(p.name))) return p.name;
  return p.isAgent ? agentLabel : p.identity;
}
