import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  type SyncElement,
  acceptedElements,
  agentOwned,
  changedSince,
  decodeMessage,
  encodeMessage,
  mergeElements,
  rememberVersions,
} from '@/lib/whiteboard-sync';

const el = (
  id: string,
  version: number,
  versionNonce = 1,
  extra: Partial<SyncElement> = {},
): SyncElement => ({
  id,
  version,
  versionNonce,
  ...extra,
});

describe('acceptedElements', () => {
  const mine = el('ai-k1-0', 1, 1, { customData: { agent: true } });
  const forged = el('ai-k1-1', 2, 1, { customData: { agent: false } });
  const anas = el('ana-1', 9, 1, { isDeleted: true });

  it('lets an AI agent touch only its own elements, whatever the drawing policy', () => {
    expect(acceptedElements([mine, forged, anas], { isAgent: true, mayDraw: false })).toEqual([mine]);
    expect(acceptedElements([anas], { isAgent: true, mayDraw: true })).toEqual([]);
    expect(agentOwned(mine)).toBe(true);
    expect(agentOwned(forged)).toBe(false);
  });

  it('keeps the room policy for people (who may also erase what the agent wrote)', () => {
    expect(acceptedElements([mine, anas], { isAgent: false, mayDraw: true })).toEqual([mine, anas]);
    expect(acceptedElements([mine, anas], { isAgent: false, mayDraw: false })).toEqual([]);
  });
});

describe('mergeElements', () => {
  it('keeps the newest version of each element and appends new ones in order', () => {
    const local = [el('a', 2), el('b', 5)];
    const merged = mergeElements(local, [el('b', 6, 1, { x: 10 }), el('a', 1), el('c', 1)]);
    expect(merged.map((e) => [e.id, e.version])).toEqual([
      ['a', 2],
      ['b', 6],
      ['c', 1],
    ]);
    expect(merged[1].x).toBe(10);
  });

  it('breaks version ties with the lower nonce, so everyone converges', () => {
    const left = mergeElements([el('a', 3, 50)], [el('a', 3, 10)]);
    const right = mergeElements([el('a', 3, 10)], [el('a', 3, 50)]);
    expect(left[0].versionNonce).toBe(10);
    expect(right[0].versionNonce).toBe(10);
  });

  it('propagates deletions as newer versions', () => {
    const merged = mergeElements([el('a', 1)], [el('a', 2, 1, { isDeleted: true })]);
    expect(merged[0].isDeleted).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const local = [el('a', 1)];
    mergeElements(local, [el('a', 2), el('b', 1)]);
    expect(local).toEqual([el('a', 1)]);
  });
});

describe('change tracking', () => {
  it('sends only what changed since last time', () => {
    const known = new Map<string, number>();
    const first = [el('a', 1), el('b', 1)];
    expect(changedSince(first, known)).toHaveLength(2);
    rememberVersions(first, known);
    expect(changedSince([el('a', 1), el('b', 2)], known).map((e) => e.id)).toEqual(['b']);
    rememberVersions([el('b', 1)], known);
    expect(known.get('b')).toBe(1);
    rememberVersions([el('b', 3)], known);
    expect(known.get('b')).toBe(3);
  });
});

describe('messages', () => {
  it('round-trips scenes and requests', () => {
    const scene = { type: 'scene' as const, elements: [el('a', 1)] };
    expect(decodeMessage(encodeMessage(scene))).toEqual(scene);
    expect(decodeMessage(encodeMessage({ type: 'request' }))).toEqual({ type: 'request' });
  });

  it.each([
    'not json',
    'null',
    '42',
    '{"type":"other"}',
    '{"type":"scene","elements":"x"}',
    '{"type":"scene","elements":[{"id":"a","version":"1","versionNonce":1}]}',
    '{"type":"scene","elements":[{"id":"","version":1,"versionNonce":1}]}',
    `{"type":"scene","elements":[{"id":"${'x'.repeat(101)}","version":1,"versionNonce":1}]}`,
    '{"type":"scene","elements":[null]}',
  ])('ignores malformed message %#', (text) => {
    expect(decodeMessage(text)).toBeNull();
  });

  it('ignores oversized messages', () => {
    expect(decodeMessage('x'.repeat(MAX_MESSAGE_CHARS + 1))).toBeNull();
  });
});
