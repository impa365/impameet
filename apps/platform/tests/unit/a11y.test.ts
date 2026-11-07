import { describe, expect, it } from 'vitest';
import { DEFAULT_A11Y, SHORTCUTS, displayName, parseA11yPrefs } from '@/lib/a11y';

describe('accessibility preferences', () => {
  it('falls back to the defaults on missing or broken data', () => {
    expect(parseA11yPrefs(null)).toEqual(DEFAULT_A11Y);
    expect(parseA11yPrefs('{oops')).toEqual(DEFAULT_A11Y);
    expect(parseA11yPrefs('{"sounds": false, "largeCaptions": "yes"}')).toEqual({
      ...DEFAULT_A11Y,
      sounds: false,
    });
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
