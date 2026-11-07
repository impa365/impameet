import { describe, expect, it } from 'vitest';
import {
  type PollMessage,
  type PollState,
  applyPollMessage,
  decodePollMessage,
  emptyPolls,
  mergePolls,
  tally,
} from '@/lib/polls';

const newPoll = (id = 'p1', options = ['Sim', 'Não']): PollMessage => ({
  type: 'poll',
  poll: { id, question: 'Aprovamos?', options, byName: 'Ana', createdAt: 1 },
});

function run(...steps: [PollMessage, string][]): PollState {
  return steps.reduce((s, [m, who]) => applyPollMessage(s, m, who), emptyPolls());
}

describe('polls', () => {
  it('creates polls owned by the real sender and counts one vote per person', () => {
    const s = run(
      [newPoll(), 'ana'],
      [{ type: 'vote', pollId: 'p1', option: 0 }, 'bia'],
      [{ type: 'vote', pollId: 'p1', option: 1 }, 'bia'],
      [{ type: 'vote', pollId: 'p1', option: 0 }, 'caio'],
      [{ type: 'vote', pollId: 'p1', option: 9 }, 'dani'],
      [{ type: 'vote', pollId: 'nope', option: 0 }, 'dani'],
      [newPoll(), 'intruso'],
    );
    expect(s.polls).toHaveLength(1);
    expect(s.polls[0].by).toBe('ana');
    expect(tally(s, s.polls[0])).toEqual({ counts: [1, 1], total: 2 });
  });

  it('only the creator closes a poll, and closed polls take no votes', () => {
    let s = run([newPoll(), 'ana'], [{ type: 'close', pollId: 'p1' }, 'bia']);
    expect(s.polls[0].closed).toBe(false);
    s = applyPollMessage(s, { type: 'close', pollId: 'p1' }, 'ana');
    expect(s.polls[0].closed).toBe(true);
    expect(applyPollMessage(s, { type: 'close', pollId: 'p1' }, 'ana')).toBe(s);
    expect(applyPollMessage(s, { type: 'vote', pollId: 'p1', option: 0 }, 'bia')).toBe(s);
    expect(applyPollMessage(s, { type: 'close', pollId: 'x' }, 'ana')).toBe(s);
    expect(applyPollMessage(s, { type: 'request' }, 'ana')).toBe(s);
  });

  it('brings late joiners up to date without losing local knowledge', () => {
    const theirs = run(
      [newPoll(), 'ana'],
      [{ type: 'vote', pollId: 'p1', option: 1 }, 'bia'],
      [{ type: 'close', pollId: 'p1' }, 'ana'],
    );
    theirs.votes.p1.forjado = 7;
    theirs.votes.fantasma = { x: 0 };
    const mine = run(
      [newPoll('p2'), 'caio'],
      [newPoll(), 'ana'],
      [{ type: 'vote', pollId: 'p1', option: 0 }, 'bia'],
    );
    const merged = applyPollMessage(mine, { type: 'state', state: theirs }, 'ana');
    expect(merged.polls.map((p) => [p.id, p.closed])).toEqual([
      ['p2', false],
      ['p1', true],
    ]);
    expect(merged.votes.p1).toEqual({ bia: 0 });
    expect(merged.votes.fantasma).toBeUndefined();
    expect(mergePolls(emptyPolls(), theirs).votes.p1).toEqual({ bia: 1 });
  });

  it('decodes only well-formed messages', () => {
    const ok = [
      JSON.stringify(newPoll()),
      '{"type":"vote","pollId":"p1","option":1}',
      '{"type":"close","pollId":"p1"}',
      '{"type":"request"}',
      JSON.stringify({ type: 'state', state: run([newPoll(), 'ana']) }),
    ];
    for (const raw of ok) expect(decodePollMessage(raw)).not.toBeNull();
    const bad = [
      'x',
      'null',
      '{"type":"other"}',
      JSON.stringify(newPoll('p1', ['só uma'])),
      JSON.stringify(newPoll('p1', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])),
      JSON.stringify({ type: 'poll', poll: { ...(newPoll() as { poll: object }).poll, question: '' } }),
      '{"type":"vote","pollId":"p1","option":1.5}',
      '{"type":"close"}',
      '{"type":"state","state":{"polls":[{}],"votes":{}}}',
      'x'.repeat(200_001),
    ];
    for (const raw of bad) expect(decodePollMessage(raw)).toBeNull();
  });
});
