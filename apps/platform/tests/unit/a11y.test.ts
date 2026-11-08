import { describe, expect, it } from 'vitest';
import {
  CALL_THEME,
  DEFAULT_A11Y,
  SHORTCUTS,
  displayName,
  parseA11yPrefs,
  resolvePanelTheme,
} from '@/lib/a11y';

describe('accessibility preferences', () => {
  it('falls back to the defaults on missing or broken data', () => {
    expect(parseA11yPrefs(null)).toEqual(DEFAULT_A11Y);
    expect(parseA11yPrefs('{oops')).toEqual(DEFAULT_A11Y);
    expect(parseA11yPrefs('{"sounds": false, "largeCaptions": "yes"}')).toEqual({
      ...DEFAULT_A11Y,
      sounds: false,
    });
  });

  it('keeps the panel theme choice and ignores unknown values', () => {
    expect(DEFAULT_A11Y.panelTheme).toBe('system');
    expect(parseA11yPrefs('{"panelTheme": "dark"}').panelTheme).toBe('dark');
    expect(parseA11yPrefs('{"panelTheme": "light", "sounds": false}')).toEqual({
      ...DEFAULT_A11Y,
      panelTheme: 'light',
      sounds: false,
    });
    expect(parseA11yPrefs('{"panelTheme": "neon"}').panelTheme).toBe('system');
  });

  it('resolves the panel theme: explicit choice, then the system, then the dark call', () => {
    expect(resolvePanelTheme('light', true)).toBe('light');
    expect(resolvePanelTheme('dark', false)).toBe('dark');
    expect(resolvePanelTheme('system', true)).toBe('dark');
    expect(resolvePanelTheme('system', false)).toBe('light');
    expect(resolvePanelTheme('system', null)).toBe(CALL_THEME);
    expect(CALL_THEME).toBe('dark');
  });

  it('documents every shortcut once', () => {
    expect(new Set(SHORTCUTS.map(([keys]) => keys)).size).toBe(SHORTCUTS.length);
    expect(new Set(SHORTCUTS.map(([, action]) => action)).size).toBe(SHORTCUTS.length);
    expect(SHORTCUTS.every(([, action]) => action.startsWith('room.shortcuts.'))).toBe(true);
  });
});

describe('displayName', () => {
  it('never shows the generated agent identity', () => {
    expect(displayName({ name: 'Kaiser', identity: 'agent-AJ_1', isAgent: true })).toBe('Kaiser');
    expect(displayName({ name: 'agent-AJ_1', identity: 'agent-AJ_1', isAgent: true })).toBe(
      'Assistente de IA',
    );
    expect(displayName({ name: '', identity: 'agent-AJ_1', isAgent: true })).toBe('Assistente de IA');
    expect(displayName({ name: '', identity: 'g-123', isAgent: false })).toBe('g-123');
  });

  it('uses the translated label for unnamed agents', () => {
    expect(displayName({ name: '', identity: 'agent-AJ_1', isAgent: true }, 'AI assistant')).toBe(
      'AI assistant',
    );
    expect(displayName({ name: 'Kaiser', identity: 'agent-AJ_1', isAgent: true }, 'AI assistant')).toBe(
      'Kaiser',
    );
    expect(displayName({ name: '', identity: 'g-123', isAgent: false }, 'AI assistant')).toBe('g-123');
  });
});
