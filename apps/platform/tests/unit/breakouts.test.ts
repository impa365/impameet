import { describe, expect, it } from 'vitest';
import { decodeBreakoutMessage, distribute } from '@/lib/breakouts';
import { livekitRoomName } from '@/server/livekit';

describe('breakouts', () => {
  it('names breakout rooms after the main room', () => {
    expect(livekitRoomName('t', 'vendas')).toBe('t.vendas');
    expect(livekitRoomName('t', 'vendas', 0)).toBe('t.vendas');
    expect(livekitRoomName('t', 'vendas', 3)).toBe('t.vendas~3');
  });

  it('spreads people round-robin', () => {
    expect(distribute(['a', 'b', 'c', 'd', 'e'], 2)).toEqual({ a: 1, b: 2, c: 1, d: 2, e: 1 });
    expect(distribute([], 3)).toEqual({});
  });

  it('decodes server messages and drops impossible assignments', () => {
    expect(decodeBreakoutMessage('{"type":"close"}')).toEqual({ type: 'close' });
    expect(
      decodeBreakoutMessage('{"type":"open","count":2,"assignments":{"a":1,"b":2,"c":3,"d":"1"}}'),
    ).toEqual({
      type: 'open',
      count: 2,
      assignments: { a: 1, b: 2 },
    });
    for (const bad of [
      'x',
      'null',
      '{"type":"open","count":1.5,"assignments":{}}',
      '{"type":"open","count":2}',
      '{"type":"x"}',
    ]) {
      expect(decodeBreakoutMessage(bad)).toBeNull();
    }
  });
});
