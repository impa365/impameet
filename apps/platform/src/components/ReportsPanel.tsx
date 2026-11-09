'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { api } from './api';
import { messageOf, useLoad } from './admin/useLoad';
import { EmptyState, Loading } from './ui/EmptyState';

interface Person {
  name: string;
  talkSeconds: number;
  turns: number;
}

interface Report {
  id: string;
  roomName: string;
  agentName: string | null;
  startedAt: string;
  endedAt: string;
  participants: Person[];
  minutes: {
    summary: string;
    decisions: string[];
    tasks: { task: string; owner: string; due: string }[];
    topics: string[];
  } | null;
  status: 'pending' | 'ready' | 'failed';
  error: string | null;
  delivered: { email?: number; webhook?: string };
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The minutes and metrics of the meetings an AI agent took part in. */
export function ReportsPanel() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ reports: Report[] }>('/api/reports', 30000);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return error ? <div className="error">{error}</div> : <Loading />;
  if (data.reports.length === 0) {
    return (
      <EmptyState
        icon="auto_awesome"
        title={t('dashboard.reports.emptyTitle')}
        action={
          <Link className="btn tonal" href="/dashboard">
            {t('dashboard.goToRooms')}
          </Link>
        }
      >
        {t('dashboard.reports.emptyBody')}
      </EmptyState>
    );
  }

  async function remove(id: string) {
    if (!window.confirm(t('dashboard.reports.confirmDelete'))) return;
    try {
      await api(`/api/reports/${id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('dashboard.deleteFailed')));
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{t('dashboard.reports.title')}</h2>
      <div className="error" role="alert">
        {error}
      </div>
      <ul className="reports">
        {data.reports.map((r) => {
          const minutes = Math.max(
            1,
            Math.round((new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()) / 60000),
          );
          const people = [...r.participants].sort((a, b) => b.talkSeconds - a.talkSeconds);
          const total = people.reduce((n, p) => n + p.talkSeconds, 0) || 1;
          return (
            <li key={r.id} className="report">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong>{r.roomName}</strong>{' '}
                  <span className="muted">
                    {new Date(r.startedAt).toLocaleString(locale)} · {minutes} min
                    {r.agentName ? ` · ${r.agentName}` : ''}
                  </span>
                  {r.status === 'pending' && <span className="badge">{t('dashboard.reports.writing')}</span>}
                  {r.status === 'failed' && (
                    <span className="badge warn" title={r.error ?? ''}>
                      {t('dashboard.reports.failed')}
                    </span>
                  )}
                </div>
                <div className="row">
                  <button
                    className="btn secondary small"
                    aria-expanded={open === r.id}
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    {open === r.id ? t('dashboard.reports.hide') : t('dashboard.reports.show')}
                  </button>
                  <a className="btn small" href={`/api/reports/${r.id}?format=text`} download>
                    {t('dashboard.reports.download')}
                  </a>
                  <button className="btn danger small" onClick={() => remove(r.id)}>
                    {t('common.delete')}
                  </button>
                </div>
              </div>
              {open === r.id && (
                <div className="report-body">
                  {r.minutes?.summary && <p>{r.minutes.summary}</p>}
                  {!!r.minutes?.decisions.length && (
                    <>
                      <h4>{t('dashboard.reports.decisions')}</h4>
                      <ul>
                        {r.minutes.decisions.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {!!r.minutes?.tasks.length && (
                    <>
                      <h4>{t('dashboard.reports.tasks')}</h4>
                      <ul>
                        {r.minutes.tasks.map((task) => (
                          <li key={task.task}>
                            {task.task}
                            {task.owner && <strong> · {task.owner}</strong>}
                            {task.due && <span className="muted"> · {task.due}</span>}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h4>{t('dashboard.reports.participation')}</h4>
                  <table className="grid">
                    <thead>
                      <tr>
                        <th scope="col">{t('dashboard.reports.person')}</th>
                        <th scope="col">{t('dashboard.reports.talk')}</th>
                        <th scope="col">{t('dashboard.reports.turns')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p) => (
                        <tr key={p.name}>
                          <th scope="row">{p.name}</th>
                          <td>
                            {clock(p.talkSeconds)} ({Math.round((100 * p.talkSeconds) / total)}%)
                          </td>
                          <td>{p.turns}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.delivered.email !== undefined && (
                    <p className="muted small-print">
                      {t('dashboard.reports.emailed', { count: r.delivered.email })}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
