'use client';

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { ApiError, api } from '../api';
import { Icon } from '../ui/Icon';
import { useRoomState } from './useRoomState';

type Privacy = 'public' | 'unlisted' | 'private';

interface Destination {
  id: string;
  kind: 'rtmp' | 'youtube';
  name: string;
}

interface LiveStream {
  id: string;
  title: string;
  startedAt: string;
  startedByName: string | null;
  targets: { destinationId: string; kind: 'rtmp' | 'youtube'; name: string; watchUrl?: string }[];
}

interface LiveView {
  canLive: boolean;
  destinations: Destination[];
  active: LiveStream | null;
  failure: string | null;
}

const MAX_TARGETS = 5;
const PRIVACY: [Privacy, MessageKey][] = [
  ['public', 'live.privacyPublic'],
  ['unlisted', 'live.privacyUnlisted'],
  ['private', 'live.privacyPrivate'],
];
/** Egress failures the platform names itself (anything else is the recorder's own words). */
const KNOWN_FAILURES = new Set(['start_timeout', 'egress_lost', 'egress_failed']);

/**
 * Going live from the room: who may, where to, and the live running now. Everyone in the room
 * sees that it is live through the room state; this asks the server only for the details.
 */
export function useLive(slug: string, signedIn: boolean, onError: (message: string) => void) {
  const t = useT();
  const path = `/api/rooms/${encodeURIComponent(slug)}/live`;
  const live = useRoomState().live;
  const [view, setView] = useState<LiveView | null>(null);
  const [busy, setBusy] = useState(false);
  const stopping = useRef(false);
  const wasLive = useRef(live !== null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const reload = useCallback(async () => {
    if (!signedIn) return null;
    const v = await api<LiveView>(path).catch(() => null);
    setView(v);
    return v;
  }, [path, signedIn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The live ended without anyone here stopping it: say why, if it fell.
  useEffect(() => {
    const now = live !== null;
    if (now === wasLive.current) return;
    wasLive.current = now;
    void reload().then((v) => {
      if (!now && !stopping.current && v?.failure) {
        errorRef.current(
          KNOWN_FAILURES.has(v.failure) ? t('live.fell') : t('live.fellBecause', { error: v.failure }),
        );
      }
      stopping.current = false;
    });
  }, [live, reload, t]);

  const start = useCallback(
    async (input: { destinationIds: string[]; title: string; description: string; privacy?: Privacy }) => {
      setBusy(true);
      try {
        await api(path, { body: input });
        await reload();
        return true;
      } catch (err) {
        errorRef.current(err instanceof ApiError ? err.message : t('live.startFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [path, reload, t],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    stopping.current = true;
    try {
      await api(path, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      stopping.current = false;
      errorRef.current(err instanceof ApiError ? err.message : t('live.stopFailed'));
    } finally {
      setBusy(false);
    }
  }, [path, reload, t]);

  return { live, view, busy, start, stop };
}

export type LiveControl = ReturnType<typeof useLive>;

export function LivePanel(props: {
  control: LiveControl;
  roomName: string;
  studio: boolean;
  isAdmin: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { view, busy } = props.control;
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState(props.roomName);
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<Privacy | null>(null);

  if (!view) return <p className="meet-panel-body muted">{t('live.loading')}</p>;
  const active = view.active;

  if (active) {
    return (
      <div className="meet-panel-body live-panel">
        <p className="live-on">
          <span className="rec-dot" aria-hidden /> {t('live.onAir')}
        </p>
        <p className="muted">
          {t('live.since', {
            time: new Date(active.startedAt).toLocaleTimeString(locale, {
              hour: '2-digit',
              minute: '2-digit',
            }),
            name: active.startedByName ?? '—',
          })}
        </p>
        <ul className="live-targets">
          {active.targets.map((target) => (
            <li key={target.destinationId}>
              <Icon name={target.kind === 'youtube' ? 'smart_display' : 'sensors'} size={18} />
              <span>{target.name}</span>
              {target.watchUrl && (
                <a href={target.watchUrl} target="_blank" rel="noopener noreferrer">
                  {t('live.watch')} <Icon name="open_in_new" size={14} />
                </a>
              )}
            </li>
          ))}
        </ul>
        {view.canLive && (
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('live.stopConfirm'))) void props.control.stop();
            }}
          >
            <Icon name="stop_circle" size={18} />
            {busy ? t('live.stopping') : t('live.stop')}
          </button>
        )}
      </div>
    );
  }

  if (!view.canLive) return <p className="meet-panel-body muted">{t('live.notAllowed')}</p>;
  if (view.destinations.length === 0) {
    return (
      <div className="meet-panel-body live-panel">
        <p className="muted">{t('live.noDestinations')}</p>
        {props.isAdmin && (
          <a className="btn tonal" href="/admin?tab=streaming" target="_blank" rel="noopener noreferrer">
            <Icon name="settings" size={18} />
            {t('live.configure')}
          </a>
        )}
      </div>
    );
  }

  const youtube = view.destinations.some((d) => d.kind === 'youtube' && chosen.includes(d.id));
  const ready = chosen.length > 0 && title.trim().length > 0 && (!youtube || privacy !== null);

  function toggle(id: string) {
    setChosen((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= MAX_TARGETS ? ids : [...ids, id],
    );
  }

  async function goLive(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    await props.control.start({
      destinationIds: chosen,
      title: title.trim(),
      description: description.trim(),
      ...(youtube && privacy ? { privacy } : {}),
    });
  }

  return (
    <form className="meet-panel-body live-panel" onSubmit={goLive}>
      <p className="muted">{props.studio ? t('live.whatStudio') : t('live.whatMeeting')}</p>
      <fieldset className="plain">
        <legend>{t('live.where')}</legend>
        {view.destinations.map((d) => (
          <label key={d.id} className="agent-check">
            <input
              type="checkbox"
              checked={chosen.includes(d.id)}
              disabled={!chosen.includes(d.id) && chosen.length >= MAX_TARGETS}
              onChange={() => toggle(d.id)}
            />
            <span>
              <strong>{d.name}</strong>
              <small>{d.kind === 'youtube' ? t('live.kindYoutube') : t('live.kindRtmp')}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="live-field">
        {t('live.title')}
        <input
          className="field"
          maxLength={100}
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {youtube && (
        <>
          <label className="live-field">
            {t('live.description')}
            <textarea
              rows={3}
              maxLength={5000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="plain">
            <legend>{t('live.privacy')}</legend>
            {PRIVACY.map(([value, label]) => (
              <label key={value} className="radio-row">
                <input
                  type="radio"
                  name="live-privacy"
                  checked={privacy === value}
                  onChange={() => setPrivacy(value)}
                />
                <span>{t(label)}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      <button className="btn danger" disabled={!ready || busy}>
        <Icon name="sensors" size={18} />
        {busy ? t('live.starting') : t('live.goLive')}
      </button>
      <p className="muted small-print">{t('live.delayHint')}</p>
    </form>
  );
}
