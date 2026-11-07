'use client';

import Link from 'next/link';
import { useLocale, useT } from '@/i18n/client';
import { api } from './api';
import { messageOf, useLoad } from './admin/useLoad';
import { EmptyState, Loading } from './ui/EmptyState';

interface Transcript {
  id: string;
  roomName: string;
  startedByName: string | null;
  startedAt: string;
  endedAt: string;
  lineCount: number;
}

function minutes(from: string, to: string): string {
  const m = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  return `${m} min`;
}

export function TranscriptsPanel() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ transcripts: Transcript[] }>('/api/transcripts', 30000);
  if (!data) return error ? <div className="error">{error}</div> : <Loading />;
  if (data.transcripts.length === 0) {
    return (
      <EmptyState
        icon="description"
        title={t('dashboard.transcripts.emptyTitle')}
        action={
          <Link className="btn tonal" href="/dashboard">
            {t('dashboard.goToRooms')}
          </Link>
        }
      >
        {t('dashboard.transcripts.emptyBody')}
      </EmptyState>
    );
  }

  async function remove(id: string) {
    if (!window.confirm(t('dashboard.transcripts.confirmDelete'))) return;
    try {
      await api(`/api/transcripts/${id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('dashboard.deleteFailed')));
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{t('dashboard.transcripts.title')}</h2>
      <div className="error" role="alert">
        {error}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>{t('dashboard.columns.room')}</th>
            <th>{t('dashboard.columns.when')}</th>
            <th>{t('dashboard.columns.duration')}</th>
            <th>{t('dashboard.transcripts.colLines')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.transcripts.map((tr) => (
            <tr key={tr.id}>
              <td>
                <strong>{tr.roomName}</strong>
                {tr.startedByName && (
                  <div className="muted">{t('dashboard.byName', { name: tr.startedByName })}</div>
                )}
              </td>
              <td>{new Date(tr.startedAt).toLocaleString(locale)}</td>
              <td>{minutes(tr.startedAt, tr.endedAt)}</td>
              <td>{tr.lineCount}</td>
              <td className="row">
                <a className="btn small" href={`/api/transcripts/${tr.id}`} download>
                  {t('dashboard.transcripts.downloadTxt')}
                </a>
                <button className="btn danger small" onClick={() => remove(tr.id)}>
                  {t('common.delete')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
