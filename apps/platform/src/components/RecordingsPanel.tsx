'use client';

import Link from 'next/link';
import { serverMessage, useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from './api';
import { messageOf, useLoad } from './admin/useLoad';
import { EmptyState, Loading } from './ui/EmptyState';

interface Recording {
  id: string;
  roomName: string;
  status: 'starting' | 'recording' | 'processing' | 'ready' | 'failed';
  sizeBytes: number | null;
  durationS: number | null;
  startedByName: string | null;
  startedAt: string;
  storageKind: 's3' | 'gdrive' | null;
  storageStatus: 'pending' | 'uploading' | 'done' | 'failed' | null;
  storageLink: string | null;
  storageError: string | null;
}

/** Where the recording went in the organization's storage, and how the upload is going. */
function StorageLine({ r }: { r: Recording }) {
  const t = useT();
  if (!r.storageKind || !r.storageStatus) return null;
  const where = r.storageKind === 'gdrive' ? t('storage.inDrive') : t('storage.inS3');
  const text =
    r.storageStatus === 'done'
      ? where
      : r.storageStatus === 'uploading'
        ? t('storage.uploading')
        : r.storageStatus === 'pending'
          ? t('storage.pending')
          : t('storage.uploadFailed', { error: serverMessage(r.storageError ?? '') });
  return (
    <div className={r.storageStatus === 'failed' ? 'error small-print' : 'muted small-print'}>{text}</div>
  );
}

const STATUS: Record<Recording['status'], MessageKey> = {
  starting: 'dashboard.recordings.status.starting',
  recording: 'dashboard.recordings.status.recording',
  processing: 'dashboard.recordings.status.processing',
  ready: 'dashboard.recordings.status.ready',
  failed: 'dashboard.recordings.status.failed',
};

function duration(s: number | null): string {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}min ${s % 60}s`;
}

function size(bytes: number | null): string {
  if (!bytes) return '—';
  return bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function RecordingsPanel() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ installed: boolean; recordings: Recording[] }>(
    '/api/recordings',
    15000,
  );
  if (!data) return error ? <div className="error">{error}</div> : <Loading />;
  if (!data.installed) {
    return (
      <EmptyState icon="video_library" title={t('dashboard.recordings.unavailableTitle')}>
        {t('dashboard.recordings.unavailableBody')}
      </EmptyState>
    );
  }
  if (data.recordings.length === 0) {
    return (
      <EmptyState
        icon="video_library"
        title={t('dashboard.recordings.emptyTitle')}
        action={
          <Link className="btn tonal" href="/dashboard">
            {t('dashboard.goToRooms')}
          </Link>
        }
      >
        {t('dashboard.recordings.emptyBody')}
      </EmptyState>
    );
  }

  async function remove(id: string) {
    if (!window.confirm(t('dashboard.recordings.confirmDelete'))) return;
    try {
      await api(`/api/recordings/${id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('dashboard.deleteFailed')));
    }
  }

  return (
    <section className="card">
      <h2 className="card-title">{t('dashboard.recordings.title')}</h2>
      <div className="error" role="alert">
        {error}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>{t('dashboard.columns.room')}</th>
            <th>{t('dashboard.columns.when')}</th>
            <th>{t('dashboard.columns.duration')}</th>
            <th>{t('dashboard.recordings.colSize')}</th>
            <th>{t('dashboard.recordings.colStatus')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.recordings.map((r) => (
            <tr key={r.id}>
              <td>
                <strong>{r.roomName}</strong>
                {r.startedByName && (
                  <div className="muted">{t('dashboard.byName', { name: r.startedByName })}</div>
                )}
              </td>
              <td>{new Date(r.startedAt).toLocaleString(locale)}</td>
              <td>{duration(r.durationS)}</td>
              <td>{size(r.sizeBytes)}</td>
              <td>
                {t(STATUS[r.status])}
                <StorageLine r={r} />
              </td>
              <td className="row">
                {r.status === 'ready' && (
                  <a className="btn small" href={`/api/recordings/${r.id}`} download>
                    {t('common.download')}
                  </a>
                )}
                {r.storageStatus === 'done' && r.storageLink && (
                  <a
                    className="btn secondary small"
                    href={r.storageLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('storage.openInDrive')}
                  </a>
                )}
                {(r.status === 'ready' || r.status === 'failed') && r.storageStatus !== 'uploading' && (
                  <button className="btn danger small" onClick={() => remove(r.id)}>
                    {t('common.delete')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
