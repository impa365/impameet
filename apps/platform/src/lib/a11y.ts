import type { MessageKey } from '@/i18n/keys';

/** What the call says out loud to screen readers and which sounds it plays. */
export interface A11yPrefs {
  announceJoins: boolean;
  announceChat: boolean;
  announceActivity: boolean;
  sounds: boolean;
  largeCaptions: boolean;
}

export const DEFAULT_A11Y: A11yPrefs = {
  announceJoins: true,
  announceChat: true,
  announceActivity: true,
  sounds: true,
  largeCaptions: false,
};

export const A11Y_STORAGE_KEY = 'impa-a11y';

export function parseA11yPrefs(raw: string | null): A11yPrefs {
  if (!raw) return DEFAULT_A11Y;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: keyof A11yPrefs) =>
      typeof data[k] === 'boolean' ? (data[k] as boolean) : DEFAULT_A11Y[k];
    return {
      announceJoins: pick('announceJoins'),
      announceChat: pick('announceChat'),
      announceActivity: pick('announceActivity'),
      sounds: pick('sounds'),
      largeCaptions: pick('largeCaptions'),
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
