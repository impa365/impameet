/**
 * Meeting polls, kept in every browser and synchronised over a LiveKit text-stream topic.
 * The sender identity comes from LiveKit (not from the message), so nobody can vote or close
 * a poll on someone else's behalf.
 */

export const POLLS_TOPIC = 'impa-polls';
export const MAX_OPTIONS = 6;
const MAX_POLLS = 50;

export interface Poll {
  id: string;
  question: string;
  options: string[];
  by: string;
  byName: string;
  closed: boolean;
  createdAt: number;
}

export interface PollState {
  polls: Poll[];
  /** pollId -> voter identity -> option index */
  votes: Record<string, Record<string, number>>;
}

export type PollMessage =
  | { type: 'poll'; poll: Omit<Poll, 'by' | 'closed'> & { byName: string } }
  | { type: 'vote'; pollId: string; option: number }
  | { type: 'close'; pollId: string }
  | { type: 'request' }
  | { type: 'state'; state: PollState };

export const emptyPolls = (): PollState => ({ polls: [], votes: {} });

const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function validPoll(p: unknown): p is Poll {
  if (typeof p !== 'object' || p === null) return false;
  const x = p as Record<string, unknown>;
  return (
    text(x.id, 64) &&
    text(x.question, 300) &&
    Array.isArray(x.options) &&
    x.options.length >= 2 &&
    x.options.length <= MAX_OPTIONS &&
    x.options.every((o) => text(o, 120)) &&
    typeof x.byName === 'string' &&
    x.byName.length <= 80 &&
    typeof x.createdAt === 'number'
  );
}

export function decodePollMessage(raw: string): PollMessage | null {
  if (raw.length > 200_000) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  switch (m.type) {
    case 'poll':
      return validPoll(m.poll) ? { type: 'poll', poll: m.poll } : null;
    case 'vote':
      return text(m.pollId, 64) && Number.isInteger(m.option)
        ? { type: 'vote', pollId: m.pollId, option: m.option as number }
        : null;
    case 'close':
      return text(m.pollId, 64) ? { type: 'close', pollId: m.pollId } : null;
    case 'request':
      return { type: 'request' };
    case 'state': {
      const s = m.state as PollState | undefined;
      const ok = s && Array.isArray(s.polls) && s.polls.every(validPoll) && typeof s.votes === 'object';
      return ok ? { type: 'state', state: s } : null;
    }
    default:
      return null;
  }
}

/** Applies one message from `sender` (a LiveKit identity). Unknown or forged changes are ignored. */
export function applyPollMessage(state: PollState, message: PollMessage, sender: string): PollState {
  switch (message.type) {
    case 'poll': {
      if (state.polls.some((p) => p.id === message.poll.id)) return state;
      const poll: Poll = { ...message.poll, by: sender, closed: false };
      return { ...state, polls: [...state.polls, poll].slice(-MAX_POLLS) };
    }
    case 'vote': {
      const poll = state.polls.find((p) => p.id === message.pollId);
      if (!poll || poll.closed || message.option < 0 || message.option >= poll.options.length) return state;
      return {
        ...state,
        votes: { ...state.votes, [poll.id]: { ...state.votes[poll.id], [sender]: message.option } },
      };
    }
    case 'close': {
      const poll = state.polls.find((p) => p.id === message.pollId);
      if (!poll || poll.by !== sender || poll.closed) return state;
      return { ...state, polls: state.polls.map((p) => (p.id === poll.id ? { ...p, closed: true } : p)) };
    }
    case 'state':
      return mergePolls(state, message.state);
    default:
      return state;
  }
}

/** Late joiners adopt what others already know; closing and votes only ever accumulate. */
export function mergePolls(mine: PollState, theirs: PollState): PollState {
  const polls = [...mine.polls];
  for (const p of theirs.polls) {
    const i = polls.findIndex((x) => x.id === p.id);
    if (i < 0) polls.push(p);
    else if (p.closed && !polls[i].closed) polls[i] = { ...polls[i], closed: true };
  }
  const votes: PollState['votes'] = { ...mine.votes };
  for (const [pollId, byVoter] of Object.entries(theirs.votes ?? {})) {
    const poll = polls.find((p) => p.id === pollId);
    if (!poll || typeof byVoter !== 'object' || byVoter === null) continue;
    const valid = Object.fromEntries(
      Object.entries(byVoter).filter(([, o]) => Number.isInteger(o) && o >= 0 && o < poll.options.length),
    );
    votes[pollId] = { ...valid, ...votes[pollId] };
  }
  return { polls: polls.slice(-MAX_POLLS), votes };
}

export function tally(state: PollState, poll: Poll): { counts: number[]; total: number } {
  const counts = poll.options.map(() => 0);
  for (const option of Object.values(state.votes[poll.id] ?? {})) counts[option] += 1;
  return { counts, total: counts.reduce((a, b) => a + b, 0) };
}
