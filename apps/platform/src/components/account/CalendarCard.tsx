'use client';

import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { messageOf, useLoad } from '../admin/useLoad';
import { api } from '../api';
import { Icon } from '../ui/Icon';

interface CalendarView {
  available: boolean;
  encryption: boolean;
  connected: { email: string | null; since: string } | null;
}

const STATUS: Record<string, MessageKey> = {
  connected: 'calendar.statusConnected',
  cancelled: 'calendar.statusCancelled',
  error: 'calendar.statusError',
  scope: 'calendar.statusScope',
};

/** The person's own Google Calendar: meetings they schedule show up there, with the room link. */
export function CalendarCard() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<{ calendar: CalendarView }>('/api/account/calendar');
  const calendar = data?.calendar;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  // Back from Google: say how it went, and clean the address.
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('calendar');
    if (!status) return;
    setNotice({ ok: status === 'connected', text: t(STATUS[status] ?? 'calendar.statusError') });
    url.searchParams.delete('calendar');
    window.history.replaceState(null, '', url.toString());
  }, [t]);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const { url } = await api<{ url: string }>('/api/account/calendar', { body: {} });
      window.location.assign(url);
    } catch (err) {
      setError(messageOf(err, t('calendar.couldNotConnect')));
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(t('calendar.disconnectConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/account/calendar', { method: 'DELETE', body: {} });
      await reload();
      setNotice({ ok: true, text: t('calendar.disconnected') });
    } catch (err) {
      setError(messageOf(err, t('calendar.couldNotConnect')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section account-card calendar-card">
      <header className="section-head">
        <h3>
          <Icon name="calendar_month" size={20} /> {t('calendar.title')}
        </h3>
        <p>{t('calendar.intro')}</p>
      </header>
      {calendar?.connected ? (
        <p className="status-line">
          <span className="status-dot" aria-hidden />
          {t('calendar.connectedAs', {
            email: calendar.connected.email ?? '—',
            date: new Date(calendar.connected.since).toLocaleDateString(locale),
          })}
        </p>
      ) : (
        calendar && !calendar.available && <p className="int-empty">{t('calendar.unavailable')}</p>
      )}
      <div className="save-bar">
        {calendar?.connected ? (
          <>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void connect()}>
              {t('calendar.reconnect')}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void disconnect()}>
              {t('calendar.disconnect')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || !calendar?.available || !calendar.encryption}
            onClick={() => void connect()}
          >
            <Icon name="calendar_month" size={18} />
            {busy ? t('calendar.connecting') : t('calendar.connect')}
          </button>
        )}
      </div>
      <p className="field-help">{t('calendar.privacy')}</p>
      {notice && (
        <p className={notice.ok ? 'status-line' : 'error'} role="status">
          {notice.text}
        </p>
      )}
      <div className="error" role="alert">
        {error}
      </div>
    </section>
  );
}
