export const BREAKOUT_TOPIC = 'impa-breakout';

export interface BreakoutSession {
  count: number;
  assignments: Record<string, number>;
}

export type BreakoutMessage = ({ type: 'open' } & BreakoutSession) | { type: 'close' };

export function decodeBreakoutMessage(raw: string): BreakoutMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  if (m.type === 'close') return { type: 'close' };
  if (
    m.type !== 'open' ||
    !Number.isInteger(m.count) ||
    typeof m.assignments !== 'object' ||
    !m.assignments
  ) {
    return null;
  }
  const count = m.count as number;
  const assignments = Object.fromEntries(
    Object.entries(m.assignments as Record<string, unknown>).filter(
      (e): e is [string, number] =>
        Number.isInteger(e[1]) && (e[1] as number) >= 1 && (e[1] as number) <= count,
    ),
  );
  return { type: 'open', count, assignments };
}

/** Round-robin split of people into `count` rooms, in the order given. */
export function distribute(identities: string[], count: number): Record<string, number> {
  return Object.fromEntries(identities.map((id, i) => [id, (i % count) + 1]));
}
