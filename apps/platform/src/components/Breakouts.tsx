'use client';

import type { Participant, Room } from 'livekit-client';
import { RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { BREAKOUT_TOPIC, type BreakoutSession, decodeBreakoutMessage, distribute } from '@/lib/breakouts';
import { ApiError, api } from './api';

const MOVE_DELAY_MS = 3000;

/** Follows the meeting's breakout session and moves this participant when told to. */
export function useBreakouts(room: Room, slug: string, current: number, onSwitch: (target: number) => void) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [session, setSession] = useState<BreakoutSession | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [notice, setNotice] = useState('');
  const switchRef = useRef(onSwitch);
  switchRef.current = onSwitch;

  const reload = useCallback(async () => {
    const res = await api<{ session: BreakoutSession | null; canManage: boolean }>(
      `/api/rooms/${encodeURIComponent(slug)}/breakouts`,
    ).catch(() => null);
    if (res) {
      setSession(res.session);
      setCanManage(res.canManage);
    }
  }, [slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onData = (payload: Uint8Array, _p?: Participant, _k?: unknown, topic?: string) => {
      if (topic !== BREAKOUT_TOPIC) return;
      const message = decodeBreakoutMessage(new TextDecoder().decode(payload));
      if (!message) return;
      if (message.type === 'close') {
        setSession(null);
        if (current > 0) {
          setNotice(tRef.current('room.breakouts.closedNotice'));
          timer = setTimeout(() => switchRef.current(0), MOVE_DELAY_MS);
        }
        return;
      }
      setSession({ count: message.count, assignments: message.assignments });
      const mine = message.assignments[room.localParticipant.identity];
      if (mine && mine !== current) {
        setNotice(tRef.current('room.breakouts.movedNotice', { n: mine }));
        timer = setTimeout(() => switchRef.current(mine), MOVE_DELAY_MS);
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      if (timer) clearTimeout(timer);
    };
  }, [room, current]);

  return { session, canManage, notice, reload };
}

export function BreakoutsView(props: {
  slug: string;
  current: number;
  breakouts: ReturnType<typeof useBreakouts>;
  participants: Participant[];
  onSwitch: (target: number) => void;
}) {
  const t = useT();
  const { session, canManage, reload } = props.breakouts;
  const people = props.participants.filter((p) => !p.isAgent && !p.isLocal);
  const [count, setCount] = useState(2);
  const [plan, setPlan] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const assignment = {
    ...distribute(
      people.map((p) => p.identity),
      count,
    ),
    ...plan,
  };

  async function call(method: 'POST' | 'DELETE', body: unknown) {
    setError('');
    try {
      await api(`/api/rooms/${encodeURIComponent(props.slug)}/breakouts`, { method, body });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.breakouts.failed'));
    }
  }

  return (
    <>
      <div className="error" role="alert">
        {error}
      </div>
      {session ? (
        <>
          <p className="muted">{t('room.breakouts.open', { count: session.count })}</p>
          {props.current > 0 && (
            <button className="btn small" onClick={() => props.onSwitch(0)}>
              {t('room.breakouts.backToMain')}
            </button>
          )}
          {Array.from({ length: session.count }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className="btn secondary small"
              disabled={n === props.current}
              onClick={() => props.onSwitch(n)}
            >
              {n === props.current ? t('room.breakouts.youAreIn', { n }) : t('room.breakouts.goTo', { n })}
            </button>
          ))}
          {canManage && (
            <button className="btn danger small" onClick={() => call('DELETE', {})}>
              {t('room.breakouts.end')}
            </button>
          )}
        </>
      ) : canManage ? (
        <>
          <label className="form">
            {t('room.breakouts.howMany')}
            <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: 9 }, (_, i) => i + 2).map((n) => (
                <option key={n} value={n}>
                  {t('room.breakouts.nRooms', { n })}
                </option>
              ))}
            </select>
          </label>
          {people.length === 0 && <p className="muted">{t('room.breakouts.nobody')}</p>}
          {people.map((p) => (
            <label key={p.identity} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{p.name || p.identity}</span>
              <select
                value={Math.min(assignment[p.identity] ?? 1, count)}
                onChange={(e) => setPlan({ ...plan, [p.identity]: Number(e.target.value) })}
              >
                {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {t('room.roomN', { n })}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button
            className="btn small"
            onClick={() =>
              call('POST', {
                count,
                assignments: Object.fromEntries(
                  people.map((p) => [p.identity, Math.min(assignment[p.identity] ?? 1, count)]),
                ),
              })
            }
          >
            {t('room.breakouts.start')}
          </button>
        </>
      ) : (
        <p className="muted">{t('room.breakouts.none')}</p>
      )}
    </>
  );
}
