import { describe, expect, it } from 'vitest';
import { EMPTY_STUDIO, MAX_ON_STAGE, layoutShape, parseStudio } from '@/lib/studio';

describe('studio stage', () => {
  it('reads a stage from the room metadata or the database', () => {
    const state = {
      layout: 'screen',
      stage: ['g-a', 'g-b'],
      screen: 'g-b',
      banners: [{ id: 'b1', text: ' Olá ', style: 'ticker' }],
      banner: 'b1',
      names: false,
      brand: { color: '#ABCDEF', background: '#000000', logo: 'https://x.test/l.png' },
    };
    const expected = { ...state, banners: [{ id: 'b1', text: 'Olá', style: 'ticker' }] };
    expect(parseStudio(state)).toEqual(expected);
    expect(parseStudio(JSON.stringify(state))).toEqual(expected);
  });

  it('never throws: anything unknown or unsafe falls back', () => {
    for (const raw of ['', 'not json', '42', null, undefined, 7, [], {}])
      expect(parseStudio(raw)).toEqual(EMPTY_STUDIO);
    const odd = parseStudio({
      layout: 'mosaic',
      stage: ['g-a', 'g-a', 5, '', ...Array.from({ length: 20 }, (_, i) => `g-${i}`)],
      screen: '',
      banners: [
        { id: '', text: 'x' },
        { id: 'b2', text: '   ' },
        'nope',
        { id: 'b3', text: 'ok', style: 'weird' },
      ],
      banner: 'b2',
      brand: { color: 'red', background: 12, logo: 'javascript:alert(1)' },
    });
    expect(odd.layout).toBe('grid');
    expect(odd.stage).toHaveLength(MAX_ON_STAGE);
    expect(odd.stage[0]).toBe('g-a');
    expect(odd.screen).toBeNull();
    expect(odd.banners).toEqual([{ id: 'b3', text: 'ok', style: 'bar' }]);
    expect(odd.banner).toBeNull();
    expect(odd.names).toBe(true);
    expect(odd.brand).toEqual(EMPTY_STUDIO.brand);
  });

  it('knows how each layout uses the stage', () => {
    expect(layoutShape('solo')).toEqual({ max: 1, screenFirst: false });
    expect(layoutShape('grid').screenFirst).toBe(false);
    expect(layoutShape('leader').max).toBe(MAX_ON_STAGE);
    expect(layoutShape('screen').screenFirst).toBe(true);
    expect(layoutShape('pip').screenFirst).toBe(true);
  });
});
