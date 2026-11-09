'use client';

import type { Participant, Room } from 'livekit-client';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';

export const COPILOT_TOPIC = 'impa.copilot';
const INSIGHTS_ATTRIBUTE = 'impa.insights';
const ACCESS_ATTRIBUTE = 'impa.insights.access';
const ANSWER_TIMEOUT_MS = 60_000;
const METRICS_REFRESH_MS = 15_000;
const MANAGERS = new Set(['admin', 'manager']);

type Kind = 'ask' | 'catchup' | 'metrics';

export interface MetricsPerson {
  name: string;
  talkSeconds: number;
  share: number;
  turns: number;
  present: boolean;
}

interface Reply {
  id: string;
  type: 'answer' | 'metrics' | 'error';
  text?: string;
  empty?: boolean;
  code?: string;
  durationS?: number;
  people?: MetricsPerson[];
}

export interface Insights {
  catchup: boolean;
  copilot: boolean;
  metrics: boolean;
  /** Something to show in the call's menu for this person. */
  any: boolean;
  ask: (type: Kind, text?: string) => Promise<Reply>;
}

/** The agent (if any) offering each feature, and whether this person may use it. */
export function availableInsights(
  agents: { identity: string; attributes?: Record<string, string> }[],
  me: { attributes?: Record<string, string> },
): { catchup?: string; copilot?: string; metrics?: string } {
  const manager = MANAGERS.has(me.attributes?.['impa.org'] ?? '');
  const moderator = me.attributes?.role === 'moderator';
  const out: { catchup?: string; copilot?: string; metrics?: string } = {};
  for (const a of agents) {
    const offered = (a.attributes?.[INSIGHTS_ATTRIBUTE] ?? '').split(',').filter(Boolean);
    const sees = a.attributes?.[ACCESS_ATTRIBUTE] === 'managers' ? manager : manager || moderator;
    for (const feature of offered) {
      if (feature === 'catchup') out.catchup ??= a.identity;
      else if ((feature === 'copilot' || feature === 'metrics') && sees) out[feature] ??= a.identity;
    }
  }
  return out;
}

/** Private requests to the agent; the answers come back only to this browser. */
export function useInsights(room: Room, participants: Participant[]): Insights {
  const pending = useRef(new Map<string, (r: Reply) => void>());
  const agents = participants.filter((p) => p.isAgent);
  const offer = availableInsights(agents, room.localParticipant);

  useEffect(() => {
    room.registerTextStreamHandler(COPILOT_TOPIC, async (reader, sender) => {
      const from = room.remoteParticipants.get(sender.identity);
      if (!from?.isAgent) return;
      try {
        const reply = JSON.parse(await reader.readAll()) as Reply;
        pending.current.get(reply.id)?.(reply);
        pending.current.delete(reply.id);
      } catch {
        /* not ours */
      }
    });
    return () => room.unregisterTextStreamHandler(COPILOT_TOPIC);
  }, [room]);

  const targets = useRef(offer);
  targets.current = offer;
  const ask = useCallback(
    (type: Kind, text?: string) =>
      new Promise<Reply>((resolve) => {
        const target = targets.current[type === 'ask' ? 'copilot' : type];
        const id = crypto.randomUUID();
        if (!target) return resolve({ id, type: 'error', code: 'unavailable' });
        const timer = setTimeout(() => {
          pending.current.delete(id);
          resolve({ id, type: 'error', code: 'timeout' });
        }, ANSWER_TIMEOUT_MS);
        pending.current.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        room.localParticipant
          .sendText(JSON.stringify({ id, type, text }), {
            topic: COPILOT_TOPIC,
            destinationIdentities: [target],
          })
          .catch(() => resolve({ id, type: 'error', code: 'failed' }));
      }),
    [room],
  );

  return {
    catchup: Boolean(offer.catchup),
    copilot: Boolean(offer.copilot),
    metrics: Boolean(offer.metrics),
    any: Boolean(offer.catchup || offer.copilot || offer.metrics),
    ask,
  };
}

const ERRORS: Record<string, MessageKey> = {
  forbidden: 'room.copilot.errForbidden',
  unavailable: 'room.copilot.errUnavailable',
  too_many: 'room.copilot.errTooMany',
  timeout: 'room.copilot.errTimeout',
  actions_off: 'room.copilot.errOff',
  empty: 'room.copilot.errEmpty',
};

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Entry {
  id: string;
  question: string;
  answer: string | null;
  error?: boolean;
}

/** The private copilot: "what did I miss?", questions only you see, live metrics. */
export function CopilotView({ insights }: { insights: Insights }) {
  const t = useT();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [metrics, setMetrics] = useState<Reply | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = (r: Reply) => t(ERRORS[r.code ?? ''] ?? 'room.copilot.errFailed');

  async function run(kind: 'ask' | 'catchup', text?: string) {
    const id = crypto.randomUUID();
    const label = kind === 'catchup' ? t('room.copilot.catchup') : (text ?? '');
    setEntries((list) => [{ id, question: label, answer: null }, ...list].slice(0, 20));
    setBusy(true);
    const reply = await insights.ask(kind, text);
    setBusy(false);
    const answer =
      reply.type === 'answer'
        ? reply.empty
          ? t('room.copilot.nothingYet')
          : (reply.text ?? '')
        : errorText(reply);
    setEntries((list) =>
      list.map((e) => (e.id === id ? { ...e, answer, error: reply.type === 'error' } : e)),
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion('');
    void run('ask', text);
  }

  const { metrics: canSeeMetrics, ask } = insights;
  useEffect(() => {
    if (!canSeeMetrics) return;
    let stopped = false;
    const load = async () => {
      const reply = await ask('metrics');
      if (!stopped) setMetrics(reply);
    };
    void load();
    const timer = setInterval(load, METRICS_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [canSeeMetrics, ask]);

  return (
    <div className="meet-panel-body copilot">
      <p className="muted small-print">{t('room.copilot.private')}</p>
      {insights.catchup && (
        <button className="btn tonal" disabled={busy} onClick={() => void run('catchup')}>
          {t('room.copilot.catchup')}
        </button>
      )}
      {insights.copilot && (
        <form className="copilot-ask" onSubmit={submit}>
          <label htmlFor="copilot-question">{t('room.copilot.askLabel')}</label>
          <textarea
            id="copilot-question"
            rows={2}
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t('room.copilot.askPlaceholder')}
          />
          <button className="btn" disabled={busy || !question.trim()}>
            {t('room.copilot.send')}
          </button>
        </form>
      )}
      {entries.length > 0 && (
        <ol className="copilot-answers" aria-label={t('room.copilot.answers')} aria-live="polite">
          {entries.map((e) => (
            <li key={e.id}>
              <strong>{e.question}</strong>
              <p className={e.error ? 'error' : undefined}>
                {e.answer ?? <span className="muted">{t('room.copilot.thinking')}</span>}
              </p>
            </li>
          ))}
        </ol>
      )}
      {insights.metrics && (
        <section aria-labelledby="copilot-metrics">
          <h4 id="copilot-metrics">{t('room.copilot.metrics')}</h4>
          {!metrics ? (
            <p className="muted">{t('room.copilot.thinking')}</p>
          ) : metrics.type !== 'metrics' ? (
            <p className="error">{errorText(metrics)}</p>
          ) : (
            <>
              <p className="muted">{t('room.copilot.duration', { time: clock(metrics.durationS ?? 0) })}</p>
              <table className="grid copilot-metrics">
                <thead>
                  <tr>
                    <th scope="col">{t('room.copilot.person')}</th>
                    <th scope="col">{t('room.copilot.talk')}</th>
                    <th scope="col">{t('room.copilot.turns')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(metrics.people ?? []).map((p) => (
                    <tr key={p.name}>
                      <th scope="row">
                        {p.name}
                        {!p.present && <span className="muted"> · {t('room.copilot.left')}</span>}
                      </th>
                      <td>
                        <span
                          className="talk-bar"
                          style={{ width: `${Math.max(2, p.share)}%` }}
                          aria-hidden
                        />
                        {clock(p.talkSeconds)} ({p.share}%)
                      </td>
                      <td>{p.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  );
}
