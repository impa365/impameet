import { describe, expect, it } from 'vitest';
import {
  EMPTY_STUDIO,
  MAX_ON_STAGE,
  MAX_SOURCES,
  SOURCE_PRESETS,
  addScene,
  addSourceToPreview,
  copyProgramToPreview,
  cutPreviewToProgram,
  deleteScene,
  duplicateScene,
  formatClock,
  layoutShape,
  parseStudio,
  previewScene,
  programScene,
  removeSourceFromPreview,
  renameScene,
  setTransition,
  sortedSources,
  updatePreview,
  updateSourceInPreview,
} from '@/lib/studio';

describe('studio stage', () => {
  it('migrates a legacy flat stage into Program + Preview scenes', () => {
    const state = {
      layout: 'screen',
      stage: ['g-a', 'g-b'],
      screen: 'g-b',
      banners: [{ id: 'b1', text: ' Olá ', style: 'ticker' }],
      banner: 'b1',
      names: false,
      brand: { color: '#ABCDEF', background: '#000000', logo: 'https://x.test/l.png' },
    };
    const parsed = parseStudio(state);
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.programId).not.toBe(parsed.previewId);
    expect(programScene(parsed)).toMatchObject({
      layout: 'screen',
      stage: ['g-a', 'g-b'],
      screen: 'g-b',
      banner: 'b1',
      names: false,
      sources: [],
    });
    expect(previewScene(parsed).banners[0].text).toBe('Olá');
    expect(parseStudio(JSON.stringify(state)).scenes).toHaveLength(2);
  });

  it('never throws: anything unknown or unsafe falls back', () => {
    for (const raw of ['', 'not json', '42', null, undefined, 7, [], {}]) {
      const s = parseStudio(raw);
      expect(s.scenes.length).toBeGreaterThanOrEqual(2);
      expect(s.programId).not.toBe(s.previewId);
    }
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
      sources: [
        { type: 'browser', url: 'http://evil.test', name: 'bad' },
        { type: 'text', text: '', name: 'empty' },
        { type: 'clock', format: 'nope', color: '#fff', name: 'clk' },
      ],
    });
    expect(programScene(odd).layout).toBe('grid');
    expect(programScene(odd).stage).toHaveLength(MAX_ON_STAGE);
    expect(programScene(odd).stage[0]).toBe('g-a');
    expect(programScene(odd).screen).toBeNull();
    expect(programScene(odd).banners).toEqual([{ id: 'b3', text: 'ok', style: 'bar' }]);
    expect(programScene(odd).banner).toBeNull();
    expect(programScene(odd).brand).toEqual(EMPTY_STUDIO.scenes[0].brand);
    expect(programScene(odd).sources).toHaveLength(1);
    expect(programScene(odd).sources[0].type).toBe('clock');
  });

  it('edits Preview without changing Program until cut', () => {
    let state = parseStudio({});
    state = updatePreview(state, (s) => ({ ...s, stage: ['u-1'], layout: 'solo' }));
    expect(previewScene(state).stage).toEqual(['u-1']);
    expect(programScene(state).stage).toEqual([]);
    state = cutPreviewToProgram(state);
    expect(programScene(state).stage).toEqual(['u-1']);
    expect(programScene(state).layout).toBe('solo');
    expect(previewScene(state).stage).toEqual(['u-1']);
  });

  it('adds scenes and knows layout shapes', () => {
    const withScene = addScene(parseStudio({}));
    expect(withScene.scenes.length).toBe(3);
    expect(layoutShape('solo')).toEqual({ max: 1, screenFirst: false });
    expect(layoutShape('grid').screenFirst).toBe(false);
    expect(layoutShape('leader').max).toBe(MAX_ON_STAGE);
    expect(layoutShape('screen').screenFirst).toBe(true);
    expect(layoutShape('pip').screenFirst).toBe(true);
  });

  it('keeps browser/image/text/clock sources and copies them on go-live', () => {
    let state = parseStudio({});
    const browser = SOURCE_PRESETS.find((p) => p.id === 'livepix')!.build();
    const lower = SOURCE_PRESETS.find((p) => p.id === 'lower')!.build();
    const clock = SOURCE_PRESETS.find((p) => p.id === 'clock')!.build();
    state = addSourceToPreview(state, browser);
    state = addSourceToPreview(state, lower);
    state = addSourceToPreview(state, clock);
    expect(previewScene(state).sources).toHaveLength(3);
    expect(programScene(state).sources).toHaveLength(0);

    state = cutPreviewToProgram(state);
    expect(programScene(state).sources).toHaveLength(3);
    expect(
      programScene(state)
        .sources.map((s) => s.type)
        .sort(),
    ).toEqual(['browser', 'clock', 'text']);

    state = updateSourceInPreview(state, lower.id, { visible: false, text: 'Convidado' });
    expect(previewScene(state).sources.find((s) => s.id === lower.id)).toMatchObject({
      visible: false,
      text: 'Convidado',
    });
    expect(programScene(state).sources.find((s) => s.id === lower.id)?.visible).toBe(true);

    state = removeSourceFromPreview(state, browser.id);
    expect(previewScene(state).sources).toHaveLength(2);
    expect(sortedSources(previewScene(state)).every((s) => s.visible)).toBe(true);
  });

  it('rejects non-https overlay URLs and keeps placeholders', () => {
    const parsed = parseStudio({
      scenes: [
        {
          id: 'sc_program',
          name: 'Ao vivo',
          layout: 'grid',
          stage: [],
          screen: null,
          banners: [],
          banner: null,
          names: true,
          brand: EMPTY_STUDIO.scenes[0].brand,
          sources: [],
        },
        {
          id: 'sc_preview',
          name: 'Montagem',
          layout: 'grid',
          stage: [],
          screen: null,
          banners: [],
          banner: null,
          names: true,
          brand: EMPTY_STUDIO.scenes[0].brand,
          sources: [
            {
              id: 's1',
              type: 'browser',
              name: 'ok',
              url: 'https://livepix.gg/',
              muted: true,
              visible: true,
              z: 1,
              opacity: 1,
              box: { x: 0, y: 0, w: 10, h: 10 },
            },
            {
              id: 's2',
              type: 'browser',
              name: 'bad',
              url: 'ftp://x',
              muted: true,
              visible: true,
              z: 1,
              opacity: 1,
              box: { x: 0, y: 0, w: 10, h: 10 },
            },
            {
              id: 's3',
              type: 'image',
              name: 'draft',
              url: 'https://',
              visible: true,
              z: 1,
              opacity: 1,
              box: { x: 0, y: 0, w: 10, h: 10 },
            },
          ],
        },
      ],
      programId: 'sc_program',
      previewId: 'sc_preview',
      transition: 'fade',
    });
    expect(parsed.transition).toBe('fade');
    expect(previewScene(parsed).sources.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('renames, duplicates, deletes scenes and can pull Program into Preview', () => {
    let state = parseStudio({});
    state = addScene(state, 'Abertura');
    const opening = state.scenes.find((s) => s.name === 'Abertura')!;
    state = addSourceToPreview(state, SOURCE_PRESETS[0].build());
    state = cutPreviewToProgram(state);
    expect(programScene(state).sources).toHaveLength(1);

    state = setTransition(state, 'fade');
    expect(state.transition).toBe('fade');

    state = renameScene(state, opening.id, 'Cold open');
    expect(state.scenes.find((s) => s.id === opening.id)?.name).toBe('Cold open');

    state = duplicateScene(state, opening.id);
    expect(state.scenes.some((s) => s.name.includes('cópia'))).toBe(true);
    expect(state.scenes.length).toBe(4);

    const extra = state.scenes.find((s) => s.name.includes('cópia'))!;
    state = deleteScene(state, extra.id);
    expect(state.scenes).toHaveLength(3);

    expect(previewScene(state).id).not.toBe(programScene(state).id);
    state = updatePreview(state, (s) => ({ ...s, stage: ['only-preview'], sources: [] }));
    expect(previewScene(state).stage).toEqual(['only-preview']);
    expect(programScene(state).sources).toHaveLength(1);
    state = copyProgramToPreview(state);
    expect(previewScene(state).sources).toHaveLength(1);
    expect(previewScene(state).stage).toEqual(programScene(state).stage);
  });

  it('caps sources and formats the clock', () => {
    let state = parseStudio({});
    for (let i = 0; i < MAX_SOURCES + 3; i++) {
      state = addSourceToPreview(state, {
        ...SOURCE_PRESETS.find((p) => p.id === 'clock')!.build(),
        id: `src_${i}`,
        name: `c${i}`,
      });
    }
    expect(previewScene(state).sources).toHaveLength(MAX_SOURCES);

    const at = new Date('2026-11-15T15:04:05Z');
    expect(formatClock('time', at, 'en-US')).toMatch(/\d/);
    expect(formatClock('seconds', at, 'pt-BR')).toMatch(/\d/);
    expect(formatClock('date', at, 'pt-BR').length).toBeGreaterThan(3);
  });

  it('exposes ready-made presets', () => {
    expect(SOURCE_PRESETS.map((p) => p.id).sort()).toEqual(['alert', 'clock', 'livepix', 'lower', 'qr']);
    for (const p of SOURCE_PRESETS) {
      const src = p.build();
      expect(src.id).toBeTruthy();
      expect(src.box.w).toBeGreaterThan(0);
    }
  });
});
