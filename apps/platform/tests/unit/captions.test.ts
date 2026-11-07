import { describe, expect, it } from 'vitest';
import {
  CAPTION_TTL_MS,
  type Caption,
  MAX_CAPTIONS,
  addCaption,
  parseCaption,
  visibleCaptions,
} from '@/lib/captions';

const msg = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 's1', identity: 'u-1', name: 'Ana', text: 'bom dia', final: false, ...over });

describe('captions', () => {
  it('parses worker messages', () => {
    expect(parseCaption(msg(), 5)).toEqual({
      id: 's1',
      identity: 'u-1',
      name: 'Ana',
      text: 'bom dia',
      final: false,
      at: 5,
    });
    expect(parseCaption(msg({ name: 'x'.repeat(200) }), 0)?.name).toHaveLength(80);
  });

  it.each([
    'nope',
    'null',
    '1',
    msg({ text: '' }),
    msg({ final: 'yes' }),
    msg({ id: 1 }),
    msg({ text: 'x'.repeat(5001) }),
  ])('ignores malformed message %#', (raw) => {
    expect(parseCaption(raw, 0)).toBeNull();
  });

  it('updates a segment in place and keeps only recent lines', () => {
    const c = (id: string, text: string, at: number): Caption => parseCaption(msg({ id, text }), at)!;
    let list = addCaption([], c('s1', 'bom', 0));
    list = addCaption(list, c('s1', 'bom dia', 100));
    expect(list.map((x) => x.text)).toEqual(['bom dia']);
    for (let i = 2; i < 7; i++) list = addCaption(list, c(`s${i}`, `linha ${i}`, 200 + i));
    expect(list).toHaveLength(MAX_CAPTIONS);
    list = addCaption(list, c('late', 'depois', 300 + CAPTION_TTL_MS));
    expect(list.map((x) => x.id)).toEqual(['late']);
    expect(visibleCaptions(list, 300 + CAPTION_TTL_MS * 2)).toEqual([]);
  });
});
