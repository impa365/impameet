'use client';

import { ConnectionState, type Room, RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import {
  MAX_OPTIONS,
  POLLS_TOPIC,
  type PollMessage,
  type PollState,
  applyPollMessage,
  decodePollMessage,
  emptyPolls,
  tally,
} from '@/lib/polls';

export function usePolls(room: Room, mayCreate: (identity: string) => boolean) {
  const [state, setState] = useState<PollState>(emptyPolls);
  const allowed = useRef(mayCreate);
  allowed.current = mayCreate;
  const latest = useRef(state);
  latest.current = state;

  const send = useCallback(
    (message: PollMessage) => {
      room.localParticipant.sendText(JSON.stringify(message), { topic: POLLS_TOPIC }).catch(() => undefined);
    },
    [room],
  );

  const act = useCallback(
    (message: PollMessage) => {
      setState((s) => applyPollMessage(s, message, room.localParticipant.identity));
      send(message);
    },
    [room, send],
  );

  useEffect(() => {
    room.registerTextStreamHandler(POLLS_TOPIC, async (reader, sender) => {
      const message = decodePollMessage(await reader.readAll());
      if (!message) return;
      if (message.type === 'request') {
        if (latest.current.polls.length > 0) send({ type: 'state', state: latest.current });
        return;
      }
      if (message.type === 'poll' && !allowed.current(sender.identity)) return;
      setState((s) => applyPollMessage(s, message, sender.identity));
    });
    const askForState = () => send({ type: 'request' });
    if (room.state === ConnectionState.Connected) askForState();
    room.on(RoomEvent.Connected, askForState);
    return () => {
      room.off(RoomEvent.Connected, askForState);
      room.unregisterTextStreamHandler(POLLS_TOPIC);
    };
  }, [room, send]);

  return { state, act, me: room.localParticipant.identity };
}

export function PollsView(props: { polls: ReturnType<typeof usePolls>; myName: string; canCreate: boolean }) {
  const t = useT();
  const { state, act, me } = props.polls;
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);

  function create(e: React.FormEvent) {
    e.preventDefault();
    const clean = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || clean.length < 2) return;
    act({
      type: 'poll',
      poll: {
        id: crypto.randomUUID(),
        question: question.trim(),
        options: clean,
        byName: props.myName,
        createdAt: Date.now(),
      },
    });
    setQuestion('');
    setOptions(['', '']);
  }

  return (
    <>
      {state.polls.length === 0 && (
        <p className="muted">{props.canCreate ? t('room.polls.emptyCreate') : t('room.polls.empty')}</p>
      )}
      {[...state.polls].reverse().map((poll) => {
        const { counts, total } = tally(state, poll);
        const mine = state.votes[poll.id]?.[me];
        return (
          <div key={poll.id} className="poll">
            <strong>{poll.question}</strong>
            <div className="muted">
              {poll.byName} · {t('room.polls.votes', { count: total })}
              {poll.closed ? ` · ${t('room.polls.closed')}` : ''}
            </div>
            {poll.options.map((option, i) => {
              const pct = total ? Math.round((counts[i] / total) * 100) : 0;
              return (
                <button
                  key={i}
                  className={mine === i ? 'poll-option chosen' : 'poll-option'}
                  disabled={poll.closed}
                  aria-pressed={mine === i}
                  aria-label={`${t('room.polls.optionLabel', { option, pct })}${mine === i ? `, ${t('room.polls.yourVote')}` : ''}`}
                  onClick={() => act({ type: 'vote', pollId: poll.id, option: i })}
                >
                  <span className="poll-bar" style={{ width: `${pct}%` }} />
                  <span className="poll-label">{option}</span>
                  <span className="poll-pct">{pct}%</span>
                </button>
              );
            })}
            {poll.by === me && !poll.closed && (
              <button className="btn secondary small" onClick={() => act({ type: 'close', pollId: poll.id })}>
                {t('room.polls.close')}
              </button>
            )}
          </div>
        );
      })}
      {!props.canCreate ? (
        <p className="muted">{t('room.polls.onlyModerators')}</p>
      ) : (
        <form className="form" onSubmit={create}>
          <label>
            {t('room.polls.newPoll')}
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={300}
              placeholder={t('room.polls.question')}
            />
          </label>
          {options.map((o, i) => (
            <input
              key={i}
              value={o}
              maxLength={120}
              placeholder={t('room.polls.option', { n: i + 1 })}
              onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
            />
          ))}
          <div className="row">
            {options.length < MAX_OPTIONS && (
              <button
                type="button"
                className="btn secondary small"
                onClick={() => setOptions([...options, ''])}
              >
                {t('room.polls.addOption')}
              </button>
            )}
            <button className="btn small">{t('room.polls.create')}</button>
          </div>
        </form>
      )}
    </>
  );
}
