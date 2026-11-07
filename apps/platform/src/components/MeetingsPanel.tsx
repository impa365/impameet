'use client';

import { type FormEvent, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { ApiError, api } from './api';
import { messageOf, useLoad } from './admin/useLoad';
import { EmptyState, Loading } from './ui/EmptyState';

interface Meeting {
  id: string;
  roomSlug: string;
  roomName: string;
  title: string;
  startsAt: string;
  durationMin: number;
  invitees: string[];
  url: string;
}

function defaultStart(): string {
  const d = new Date(Date.now() + 60 * 60_000);
  d.setMinutes(0, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function MeetingsPanel({ rooms }: { rooms: { slug: string; name: string }[] }) {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ mailEnabled: boolean; meetings: Meeting[] }>(
    '/api/meetings',
  );
  const [open, setOpen] = useState(false);
  const [roomSlug, setRoomSlug] = useState(rooms[0]?.slug ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [durationMin, setDurationMin] = useState(60);
  const [invitees, setInvitees] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [invite, setInvite] = useState('');

  if (rooms.length === 0) {
    return (
      <section className="card">
        <EmptyState
          icon="meeting_room"
          title={t('dashboard.meetings.noRoomsTitle')}
          action={
            <a className="btn tonal" href="/dashboard?new=1">
              {t('dashboard.meetings.noRoomsAction')}
            </a>
          }
        >
          {t('dashboard.meetings.noRoomsBody')}
        </EmptyState>
      </section>
    );
  }

  async function schedule(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult('');
    try {
      const res = await api<{ inviteText: string; mail: { sent: number; failed: number } }>('/api/meetings', {
        body: {
          roomSlug,
          title,
          description,
          startsAt: new Date(startsAt).toISOString(),
          durationMin,
          invitees: invitees
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setInvite(res.inviteText);
      const { sent, failed } = res.mail;
      setResult(
        failed
          ? t('dashboard.meetings.mailPartial', { sent, failed })
          : sent
            ? t('dashboard.meetings.mailSent', { count: sent })
            : t('dashboard.meetings.scheduled'),
      );
      setTitle('');
      setDescription('');
      setInvitees('');
      setOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.meetings.scheduleFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!window.confirm(t('dashboard.meetings.confirmCancel'))) return;
    try {
      await api(`/api/meetings/${id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('dashboard.meetings.cancelFailed')));
    }
  }

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="card-title">{t('dashboard.meetings.title')}</h2>
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? t('common.close') : t('dashboard.meetings.schedule')}
        </button>
      </div>
      {open && (
        <form className="card form" onSubmit={schedule} style={{ marginTop: 12 }}>
          <div className="row">
            <label style={{ flex: 2 }}>
              {t('dashboard.meetings.fieldTitle')}
              <input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label style={{ flex: 1 }}>
              {t('dashboard.meetings.fieldRoom')}
              <select value={roomSlug} onChange={(e) => setRoomSlug(e.target.value)}>
                {rooms.map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('dashboard.meetings.fieldWhen')}
              <input
                type="datetime-local"
                required
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </label>
            <label style={{ flex: 1 }}>
              {t('dashboard.meetings.fieldDuration')}
              <select value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))}>
                {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                  <option key={m} value={m}>
                    {m >= 60
                      ? `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`
                      : `${m} min`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t('dashboard.meetings.fieldInvitees')}
            <input
              value={invitees}
              onChange={(e) => setInvitees(e.target.value)}
              placeholder={t('dashboard.meetings.inviteesPlaceholder')}
            />
          </label>
          <label>
            {t('dashboard.meetings.fieldAgenda')}
            <textarea
              rows={3}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {!data?.mailEnabled && (
            <p className="muted" style={{ margin: 0 }}>
              {t('dashboard.meetings.noMail')}
            </p>
          )}
          <button className="btn" disabled={busy}>
            {t('dashboard.meetings.submit')}
          </button>
        </form>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <p style={{ marginTop: 0 }}>{result}</p>
          <pre className="invite">{invite}</pre>
          <button className="btn secondary small" onClick={() => navigator.clipboard.writeText(invite)}>
            {t('dashboard.meetings.copyInvite')}
          </button>
        </div>
      )}
      {!data && !error && <Loading />}
      {data && data.meetings.length === 0 && !open && !result && (
        <EmptyState
          icon="calendar_month"
          title={t('dashboard.meetings.emptyTitle')}
          action={
            <button className="btn tonal" onClick={() => setOpen(true)}>
              {t('dashboard.meetings.emptyAction')}
            </button>
          }
        >
          {t('dashboard.meetings.emptyBody')}
        </EmptyState>
      )}
      {data && data.meetings.length > 0 && (
        <table className="grid" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>{t('dashboard.meetings.colMeeting')}</th>
              <th>{t('dashboard.columns.when')}</th>
              <th>{t('dashboard.meetings.colInvitees')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.meetings.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.title}</strong>
                  <div className="muted">{m.roomName}</div>
                </td>
                <td>
                  {new Date(m.startsAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                  {m.durationMin} min
                </td>
                <td>{m.invitees.length}</td>
                <td className="row">
                  <a className="btn small" href={m.url}>
                    {t('dashboard.meetings.enter')}
                  </a>
                  <a className="btn secondary small" href={`/api/meetings/${m.id}`} download>
                    {t('dashboard.meetings.calendar')}
                  </a>
                  <button className="btn danger small" onClick={() => cancel(m.id)}>
                    {t('common.cancel')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
