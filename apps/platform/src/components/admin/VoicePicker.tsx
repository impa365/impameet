'use client';

import { useEffect, useRef, useState } from 'react';
import { serverMessage, useT } from '@/i18n/client';
import type { SpeechProvider } from '@/lib/providers';
import { api } from '../api';
import { messageOf } from './useLoad';

export interface Voice {
  id: string;
  name: string;
  languages: string[];
  tags: string[];
  description: string;
  preview: string | null;
  family?: string;
}

type Listing = { key: string } & ({ state: 'ok'; voices: Voice[] } | { state: 'error'; error: unknown });

/**
 * The voices of the agent's speaking key, searchable and with a sample to listen to before
 * choosing. Fish Audio also offers its public library.
 */
export function VoicePicker({
  integrationId,
  kind,
  family,
  language,
  languageName,
  value,
  onPick,
  onClose,
}: {
  integrationId: string;
  kind: SpeechProvider;
  /** The chosen voice model: Deepgram voices belong to one family (flux, aura-2). */
  family: string;
  language: string;
  languageName: string;
  value: string;
  onPick: (voice: Voice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'mine' | 'public'>('mine');
  const [sameLanguage, setSameLanguage] = useState(true);
  const [licensed, setLicensed] = useState(true);
  const [listing, setListing] = useState<Listing | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const key = JSON.stringify([integrationId, query.trim(), scope, language, licensed]);

  useEffect(() => {
    let live = true;
    const [id, q, s, lang, lic] = JSON.parse(key) as [string, string, string, string, boolean];
    const timer = setTimeout(async () => {
      try {
        const res = await api<{ ok: boolean; error?: string; voices?: Voice[] }>(
          `/api/admin/integrations/${id}/voices`,
          { body: { query: q, scope: s, language: lang, licensed: lic } },
        );
        if (!live) return;
        setListing(
          res.ok
            ? { key, state: 'ok', voices: res.voices ?? [] }
            : { key, state: 'error', error: res.error ?? '' },
        );
      } catch (err) {
        if (live) setListing({ key, state: 'error', error: err });
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);

  useEffect(() => () => audio.current?.pause(), []);

  function listen(voice: Voice) {
    if (!voice.preview) return;
    const player = audio.current ?? new Audio();
    audio.current = player;
    if (playing === voice.id) {
      player.pause();
      setPlaying(null);
      return;
    }
    player.src = voice.preview;
    player.onended = () => setPlaying(null);
    player.onerror = () => setPlaying(null);
    void player.play().catch(() => setPlaying(null));
    setPlaying(voice.id);
  }

  const current = listing?.key === key ? listing : null;
  const all = current?.state === 'ok' ? current.voices : [];
  const ofFamily = kind === 'deepgram' && family ? all.filter((v) => v.family === family) : [];
  const pool = ofFamily.length > 0 ? ofFamily : all;
  const voices = sameLanguage
    ? pool.filter((v) => v.languages.length === 0 || v.languages.includes(language))
    : pool;

  return (
    <fieldset className="group voice-picker">
      <legend>{t('admin.agents.voicePickerTitle', { language: languageName })}</legend>
      <div className="row voice-picker-tools">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('admin.agents.searchVoices')}
          aria-label={t('admin.agents.searchVoices')}
        />
        {kind === 'fish' && (
          <div className="chips" role="group" aria-label={t('admin.agents.voiceScope')}>
            {(['mine', 'public'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={scope === s ? 'chip add accent' : 'chip add'}
                aria-pressed={scope === s}
                onClick={() => setScope(s)}
              >
                {t(s === 'mine' ? 'admin.agents.voiceScopeMine' : 'admin.agents.voiceScopePublic')}
              </button>
            ))}
          </div>
        )}
        <label className="model-picker-only">
          <input type="checkbox" checked={sameLanguage} onChange={(e) => setSameLanguage(e.target.checked)} />
          {t('admin.agents.sameLanguageOnly', { language: languageName })}
        </label>
        {kind === 'fish' && scope === 'public' && (
          <label className="model-picker-only">
            <input type="checkbox" checked={licensed} onChange={(e) => setLicensed(e.target.checked)} />
            {t('admin.agents.licensedOnly')}
          </label>
        )}
        <button type="button" className="btn secondary small" onClick={onClose}>
          {t('admin.agents.closePicker')}
        </button>
      </div>
      {kind === 'fish' && scope === 'public' && (
        <p className={licensed ? 'muted small-print' : 'error small-print'}>
          {t(licensed ? 'admin.agents.licensedHint' : 'admin.agents.unlicensedWarning')}
        </p>
      )}
      <p className={current?.state === 'error' ? 'error' : 'muted small-print'} role="status">
        {!current
          ? t('admin.agents.loadingVoices')
          : current.state === 'error'
            ? t('admin.agents.voicesFailed', {
                error:
                  typeof current.error === 'string'
                    ? serverMessage(current.error)
                    : messageOf(current.error, t('admin.agents.noVoices')),
              })
            : voices.length === 0
              ? t('admin.agents.noVoices')
              : t('admin.agents.voicesCount', { count: voices.length })}
      </p>
      {voices.length > 0 && (
        <ul className="model-list voice-list">
          {voices.map((v) => (
            <li key={v.id} className={v.id === value ? 'principal' : undefined}>
              <button
                type="button"
                className="btn secondary small voice-play"
                disabled={!v.preview}
                aria-label={
                  v.preview
                    ? t(playing === v.id ? 'admin.agents.stopSample' : 'admin.agents.listenSample', {
                        name: v.name,
                      })
                    : t('admin.agents.noSample')
                }
                title={v.preview ? undefined : t('admin.agents.noSample')}
                onClick={() => listen(v)}
              >
                {playing === v.id ? '■' : '▶'}
              </button>
              <div className="voice-info">
                <strong>{v.name}</strong>
                <span className="muted small-print">
                  {[v.languages.join(', ').toUpperCase(), ...v.tags.slice(0, 4)].filter(Boolean).join(' · ')}
                </span>
                {v.description && <span className="muted small-print">{v.description}</span>}
              </div>
              {v.id === value ? (
                <span className="pill ok">{t('admin.agents.inUse')}</span>
              ) : (
                <button
                  type="button"
                  className="btn small"
                  aria-label={t('admin.agents.useVoiceFor', { name: v.name, language: languageName })}
                  onClick={() => onPick(v)}
                >
                  {t('admin.agents.useVoice')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
