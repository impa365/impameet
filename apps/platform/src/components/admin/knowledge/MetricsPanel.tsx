'use client';

import { useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { useLoad } from '../useLoad';
import { type Base, kbPath } from './types';

interface Metrics {
  days: number;
  searches: number;
  empty: number;
  avgLatencyMs: number;
  byOrigin: { origin: string; count: number }[];
  daily: { day: string; count: number }[];
  topQueries: { query: string; count: number; empty: number }[];
  topChunks: { id: string; title: string; section: string; hits: number }[];
}

const ORIGIN: Record<string, MessageKey> = {
  agent: 'knowledge.metrics.originAgent',
  test: 'knowledge.metrics.originTest',
  chat: 'knowledge.metrics.originChat',
};

/** Every day of the period, with the days without searches at zero. */
function daysOf(daily: Metrics['daily'], days: number) {
  const counts = new Map(daily.map((d) => [d.day, d.count]));
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { day, count: counts.get(day) ?? 0 };
  });
}

export function MetricsPanel({ base }: { base: Base }) {
  const t = useT();
  const locale = useLocale();
  const [days, setDays] = useState(7);
  const { data, error } = useLoad<{ metrics: Metrics }>(`${kbPath(base.id)}/metrics?days=${days}`);
  const m = data?.metrics;
  const series = m ? daysOf(m.daily, days) : [];
  const peak = Math.max(1, ...series.map((d) => d.count));
  const pct = (n: number) => (m && m.searches > 0 ? Math.round((n / m.searches) * 100) : 0);

  return (
    <>
      <div className="row kb-period" role="group" aria-label={t('knowledge.metrics.period')}>
        {[7, 30].map((n) => (
          <button
            key={n}
            type="button"
            className={days === n ? 'chip add accent' : 'chip add'}
            aria-pressed={days === n}
            onClick={() => setDays(n)}
          >
            {t('knowledge.metrics.days', { count: n })}
          </button>
        ))}
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      {m && (
        <>
          <div className="kb-stats">
            <div>
              <span>{t('knowledge.metrics.searches')}</span>
              <strong>{m.searches.toLocaleString(locale)}</strong>
            </div>
            <div className={m.empty > 0 ? 'warn' : undefined}>
              <span>{t('knowledge.metrics.empty')}</span>
              <strong>
                {m.empty.toLocaleString(locale)}
                <small> · {pct(m.empty)}%</small>
              </strong>
            </div>
            <div>
              <span>{t('knowledge.metrics.latency')}</span>
              <strong>
                {t('knowledge.metrics.latencyValue', { ms: m.avgLatencyMs.toLocaleString(locale) })}
              </strong>
            </div>
          </div>
          {m.searches === 0 ? (
            <p className="int-empty">{t('knowledge.metrics.noData')}</p>
          ) : (
            <>
              <section className="settings-section">
                <header className="section-head">
                  <h3>{t('knowledge.metrics.daily')}</h3>
                </header>
                <div className="kb-bars" role="img" aria-label={t('knowledge.metrics.daily')}>
                  {series.map((d) => (
                    <span
                      key={d.day}
                      title={`${new Date(`${d.day}T12:00:00`).toLocaleDateString(locale)}: ${d.count}`}
                    >
                      <i style={{ height: `${Math.round((d.count / peak) * 100)}%` }} />
                    </span>
                  ))}
                </div>
                <h4>{t('knowledge.metrics.byOrigin')}</h4>
                <ul className="kb-origins">
                  {m.byOrigin.map((o) => (
                    <li key={o.origin}>
                      <span>{ORIGIN[o.origin] ? t(ORIGIN[o.origin]) : o.origin}</span>
                      <span className="kb-meter">
                        <i style={{ width: `${pct(o.count)}%` }} />
                      </span>
                      <strong>{o.count.toLocaleString(locale)}</strong>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="settings-section">
                <header className="section-head">
                  <h3>{t('knowledge.metrics.topQueries')}</h3>
                </header>
                <div className="table-card">
                  <table className="grid">
                    <thead>
                      <tr>
                        <th>{t('knowledge.metrics.question')}</th>
                        <th>{t('knowledge.metrics.count')}</th>
                        <th>{t('knowledge.metrics.emptyCount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.topQueries.map((q) => (
                        <tr key={q.query}>
                          <td className="strong">{q.query}</td>
                          <td>{q.count}</td>
                          <td>{q.empty > 0 ? <span className="badge warn">{q.empty}</span> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              {m.topChunks.length > 0 && (
                <section className="settings-section">
                  <header className="section-head">
                    <h3>{t('knowledge.metrics.topChunks')}</h3>
                  </header>
                  <div className="table-card">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th>{t('knowledge.metrics.chunk')}</th>
                          <th>{t('knowledge.metrics.uses')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {m.topChunks.map((c) => (
                          <tr key={c.id}>
                            <td className="strong">
                              {c.title}
                              {c.section ? <span className="muted"> · {c.section}</span> : null}
                            </td>
                            <td>{c.hits}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
