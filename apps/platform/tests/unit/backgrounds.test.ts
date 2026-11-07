import { describe, expect, it } from 'vitest';
import { BACKGROUNDS, BACKGROUND_ASSETS, findBackground, switchOptions } from '@/lib/backgrounds';

describe('backgrounds', () => {
  it('falls back to no effect for unknown or missing ids', () => {
    expect(findBackground('blur').id).toBe('blur');
    expect(findBackground('nope').id).toBe('none');
    expect(findBackground(null).mode).toBe('disabled');
  });

  it('maps every choice to processor options', () => {
    expect(switchOptions(findBackground('none'))).toEqual({ mode: 'disabled' });
    expect(switchOptions(findBackground('blur-light'))).toEqual({ mode: 'background-blur', blurRadius: 6 });
    expect(switchOptions(findBackground('azul'))).toEqual({
      mode: 'virtual-background',
      imagePath: '/backgrounds/azul.jpg',
    });
    const labelKey = 'room.backgrounds.none' as const;
    expect(switchOptions({ id: 'x', labelKey, mode: 'background-blur' })).toEqual({
      mode: 'background-blur',
      blurRadius: 10,
    });
    expect(switchOptions({ id: 'x', labelKey, mode: 'virtual-background' })).toEqual({ mode: 'disabled' });
  });

  it('labels every choice with a room message key', () => {
    expect(BACKGROUNDS.every((b) => b.labelKey.startsWith('room.backgrounds.'))).toBe(true);
  });

  it('keeps every asset on this server', () => {
    const paths = [...Object.values(BACKGROUND_ASSETS), ...BACKGROUNDS.map((b) => b.imagePath ?? '/')];
    expect(paths.every((p) => p.startsWith('/') && !p.startsWith('//'))).toBe(true);
    expect(new Set(BACKGROUNDS.map((b) => b.id)).size).toBe(BACKGROUNDS.length);
  });
});
