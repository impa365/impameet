'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

interface Destination {
  id: string;
  kind: 'rtmp' | 'youtube';
  name: string;
  rtmpUrl: string | null;
  googleEmail: string | null;
  channelTitle: string | null;
  secretHint: string;
  createdAt: string;
}

interface DestinationsView {
  encryption: boolean;
  googleAvailable: boolean;
  streaming: boolean;
  destinations: Destination[];
}

/** Common servers: picking one fills the address; the key is always the person's own. */
const PRESETS: { label: string; url: string }[] = [
  { label: 'YouTube (RTMP)', url: 'rtmps://a.rtmps.youtube.com/live2' },
  { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  { label: 'Instagram', url: 'rtmps://live-upload.instagram.com:443/rtmp' },
  { label: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
];

const STATUS: Record<string, MessageKey> = {
  connected: 'live.admin.statusConnected',
  cancelled: 'live.admin.statusCancelled',
  error: 'live.admin.statusError',
  scope: 'live.admin.statusScope',
  nochannel: 'live.admin.statusNoChannel',
};

const MAX_DESTINATIONS = 10;

/** Where the organization's meetings and studios go live: YouTube by account, or any RTMP. */
export function StreamingTab() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<DestinationsView>('/api/admin/live-destinations');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');
  const [youtubeName, setYoutubeName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const full = (data?.destinations.length ?? 0) >= MAX_DESTINATIONS;

  // Back from Google: say how it went, and clean the address.
  useEffect(() => {
    const here = new URL(window.location.href);
    const status = here.searchParams.get('youtube');
    if (!status) return;
    setNotice({ ok: status === 'connected', text: t(STATUS[status] ?? 'live.admin.statusError') });
    here.searchParams.delete('youtube');
    window.history.replaceState(null, '', here.toString());
  }, [t]);

  async function run(kind: string, work: () => Promise<void>) {
    setBusy(kind);
    setError('');
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err, t('live.admin.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  const addRtmp = (e: FormEvent) => {
    e.preventDefault();
    void run('rtmp', async () => {
      await api('/api/admin/live-destinations', {
        body: { name: name.trim(), url: url.trim(), streamKey: streamKey.trim() },
      });
      setName('');
      setUrl('');
      setStreamKey('');
      await reload();
      setNotice({ ok: true, text: t('live.admin.added') });
    });
  };

  const connectYoutube = () =>
    run('youtube', async () => {
      const res = await api<{ url: string }>('/api/admin/live-destinations/youtube', {
        body: { name: youtubeName.trim() },
      });
      window.location.assign(res.url);
    });

  const remove = (d: Destination) => {
    const extra = d.kind === 'youtube' ? t('live.admin.removeYoutubeExtra') : '';
    if (!window.confirm(t('live.admin.removeConfirm', { name: d.name, extra }))) return;
    void run(`remove:${d.id}`, async () => {
      await api(`/api/admin/live-destinations/${d.id}`, { method: 'DELETE', body: {} });
      await reload();
      setNotice({ ok: true, text: t('live.admin.removed') });
    });
  };

  return (
    <div className="settings-form storage-tab">
      <div className="page-head">
        <p>{t('live.admin.intro')}</p>
      </div>
      {data && !data.encryption && <p className="int-empty">{t('storage.encryptionMissing')}</p>}
      {data && !data.streaming && <p className="int-empty">{t('live.admin.noStreaming')}</p>}

      <section className="settings-section">
        <header className="section-head">
          <h3>{t('live.admin.destinations')}</h3>
        </header>
        {data && data.destinations.length === 0 ? (
          <p className="muted">{t('live.admin.none')}</p>
        ) : (
          <ul className="live-dests">
            {data?.destinations.map((d) => (
              <li key={d.id}>
                <span className="int-icon tile-avatar" aria-hidden>
                  <Icon name={d.kind === 'youtube' ? 'smart_display' : 'sensors'} size={20} />
                </span>
                <span className="live-dest-main">
                  <strong>{d.name}</strong>
                  <small className="muted">
                    {d.kind === 'youtube'
                      ? t('live.admin.youtubeLine', {
                          channel: d.channelTitle ?? '—',
                          email: d.googleEmail ?? '—',
                        })
                      : t('live.admin.rtmpLine', { url: d.rtmpUrl ?? '', hint: d.secretHint })}
                    {' · '}
                    {new Date(d.createdAt).toLocaleDateString(locale)}
                  </small>
                </span>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy !== null}
                  onClick={() => remove(d)}
                >
                  {t('live.admin.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-section">
        <header className="section-head">
          <h3>
            <Icon name="smart_display" size={20} /> {t('live.admin.youtubeTitle')}
          </h3>
        </header>
        <p className="field-help">{t('live.admin.youtubeHelp')}</p>
        {data && !data.googleAvailable && <p className="int-empty">{t('live.admin.googleMissing')}</p>}
        <label>
          {t('live.admin.youtubeName')}
          <input
            maxLength={80}
            value={youtubeName}
            placeholder={t('live.admin.youtubeNamePlaceholder')}
            onChange={(e) => setYoutubeName(e.target.value)}
          />
        </label>
        <div className="save-bar">
          <button
            type="button"
            className="btn"
            disabled={busy !== null || !data?.googleAvailable || !data.encryption || full}
            onClick={() => void connectYoutube()}
          >
            <Icon name="smart_display" size={18} />
            {busy === 'youtube' ? t('live.admin.connecting') : t('live.admin.connectYoutube')}
          </button>
        </div>
      </section>

      <form className="form settings-section" onSubmit={addRtmp} noValidate>
        <header className="section-head">
          <h3>
            <Icon name="sensors" size={20} /> {t('live.admin.rtmpTitle')}
          </h3>
        </header>
        <p className="field-help">{t('live.admin.rtmpHelp')}</p>
        <div className="preset-grid" role="group" aria-label={t('live.admin.rtmpPresets')}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={url === p.url ? 'preset active' : 'preset'}
              onClick={() => {
                setUrl(p.url);
                if (!name.trim()) setName(p.label.replace(/ \(.*\)$/, ''));
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label>
          {t('live.admin.rtmpName')}
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('live.admin.rtmpUrl')}
          <input
            required
            inputMode="url"
            maxLength={300}
            value={url}
            placeholder="rtmps://…"
            onChange={(e) => setUrl(e.target.value)}
          />
          <span className="field-help">{t('live.admin.rtmpUrlHelp')}</span>
        </label>
        <label>
          {t('live.admin.streamKey')}
          <input
            required
            type="password"
            autoComplete="new-password"
            maxLength={300}
            value={streamKey}
            onChange={(e) => setStreamKey(e.target.value)}
          />
          <span className="field-help">{t('live.admin.streamKeyHelp')}</span>
        </label>
        <div className="save-bar">
          <button
            className="btn"
            disabled={
              busy !== null || !data?.encryption || full || !name.trim() || !url.trim() || !streamKey.trim()
            }
          >
            {busy === 'rtmp' ? t('live.admin.saving') : t('live.admin.addRtmp')}
          </button>
        </div>
      </form>

      {full && <p className="muted">{t('live.admin.full', { max: MAX_DESTINATIONS })}</p>}
      {notice && (
        <p className={notice.ok ? 'status-line' : 'error'} role="status">
          {notice.text}
        </p>
      )}
      <div className="error" role="alert">
        {error}
      </div>
    </div>
  );
}
