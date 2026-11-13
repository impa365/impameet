'use client';

import {
  type TrackReferenceOrPlaceholder,
  VideoTrack,
  isTrackReference,
  useParticipants,
  useRoomContext,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { displayName } from '@/lib/a11y';
import { CAPTIONER_ATTRIBUTE } from '@/lib/captions';
import {
  MAX_BANNERS,
  MAX_BANNER_CHARS,
  MAX_ON_STAGE,
  STUDIO_LAYOUTS,
  type StudioBanner,
  type StudioLayout,
  type StudioState,
  parseStudio,
} from '@/lib/studio';
import { ApiError, api } from '../api';
import { Icon } from '../ui/Icon';
import { StudioCanvas, useStudioState, useStudioTracks } from './StudioCanvas';

const LAYOUT_LABEL: Record<StudioLayout, MessageKey> = {
  solo: 'studio.layout.solo',
  grid: 'studio.layout.grid',
  leader: 'studio.layout.leader',
  screen: 'studio.layout.screen',
  pip: 'studio.layout.pip',
};

/** How long a change waits for the room to echo it back before the live stage wins again. */
const ECHO_MS = 4000;

export interface StudioControl {
  state: StudioState;
  change: (edit: (s: StudioState) => StudioState) => void;
}

/**
 * The producer's handle on the stage: changes show at once and are sent to the server, which
 * pushes them to everyone through the room's metadata.
 */
export function useStudioControl(
  slug: string,
  token: string,
  onError: (message: string) => void,
): StudioControl {
  const t = useT();
  const room = useRoomContext();
  const live = useStudioState();
  const [draft, setDraft] = useState<StudioState | null>(null);
  const state = draft ?? live;
  const stateRef = useRef(state);
  stateRef.current = state;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const fallback = t('studio.saveFailed');

  useEffect(() => {
    if (!draft) return;
    if (JSON.stringify(draft) === JSON.stringify(live)) return setDraft(null);
    const timer = setTimeout(() => setDraft(null), ECHO_MS);
    return () => clearTimeout(timer);
  }, [draft, live]);

  const change = useCallback(
    (edit: (s: StudioState) => StudioState) => {
      const here = new Set([room.localParticipant.identity, ...room.remoteParticipants.keys()]);
      const edited = edit(stateRef.current);
      const next = parseStudio({
        ...edited,
        stage: edited.stage.filter((id) => here.has(id)),
        screen: edited.screen && here.has(edited.screen) ? edited.screen : null,
      });
      stateRef.current = next;
      setDraft(next);
      api(`/api/rooms/${encodeURIComponent(slug)}/studio`, {
        method: 'PUT',
        body: next,
        headers: { 'x-room-token': token },
      }).catch((err: unknown) => {
        setDraft(null);
        errorRef.current(err instanceof ApiError ? err.message : fallback);
      });
    },
    [room, slug, token, fallback],
  );

  return { state, change };
}

function Thumb(props: { trackRef: TrackReferenceOrPlaceholder | undefined; name: string }) {
  const ref = props.trackRef;
  return (
    <span className="studio-thumb" aria-hidden>
      {ref && isTrackReference(ref) && !ref.publication.isMuted ? (
        <VideoTrack trackRef={ref} />
      ) : (
        <span>{props.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

/** The producer's view: the stage as it goes out, its layouts, and everyone waiting backstage. */
function Producer(props: {
  control: StudioControl;
  onPanel: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const { state, change } = props.control;
  const tracks = useStudioTracks();
  const people = useParticipants().filter((p) => p.attributes?.[CAPTIONER_ATTRIBUTE] !== 'captions');
  const sharing = new Set(
    tracks
      .filter((r) => r.source === Track.Source.ScreenShare && isTrackReference(r))
      .map((r) => r.participant.identity),
  );

  function toggleStage(identity: string) {
    if (!state.stage.includes(identity) && state.stage.length >= MAX_ON_STAGE) {
      props.onError(t('studio.stageFull', { max: MAX_ON_STAGE }));
      return;
    }
    change((s) => ({
      ...s,
      stage: s.stage.includes(identity) ? s.stage.filter((x) => x !== identity) : [...s.stage, identity],
    }));
  }

  function toggleScreen(identity: string) {
    change((s) =>
      s.screen === identity
        ? { ...s, screen: null, layout: s.layout === 'screen' || s.layout === 'pip' ? 'grid' : s.layout }
        : { ...s, screen: identity, layout: s.layout === 'pip' ? 'pip' : 'screen' },
    );
  }

  return (
    <div className="studio-main producer">
      <div className="studio-preview">
        <StudioCanvas state={state} tracks={tracks} emptyText={t('studio.emptyStage')} />
      </div>
      <div className="studio-toolbar" role="toolbar" aria-label={t('studio.layoutTitle')}>
        <div className="studio-layouts" role="radiogroup" aria-label={t('studio.layoutTitle')}>
          {STUDIO_LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={state.layout === l}
              className={state.layout === l ? 'studio-layout-btn on' : 'studio-layout-btn'}
              onClick={() => change((s) => ({ ...s, layout: l }))}
            >
              <span className={`studio-layout-icon ${l}`} aria-hidden>
                <i />
                <i />
                <i />
              </span>
              {t(LAYOUT_LABEL[l])}
            </button>
          ))}
        </div>
        <button type="button" className="btn tonal small" onClick={props.onPanel}>
          <Icon name="title" size={18} />
          {t('studio.bannersAndBrand')}
        </button>
      </div>
      <section className="studio-backstage" aria-label={t('studio.backstage')}>
        <h4>
          {t('studio.backstage')} <small className="muted">{t('studio.backstageHint')}</small>
        </h4>
        <ul>
          {people.map((p) => {
            const name = displayName(p, t('room.aiAssistant'));
            const onStage = state.stage.includes(p.identity);
            const camera = tracks.find(
              (r) => r.participant.identity === p.identity && r.source === Track.Source.Camera,
            );
            return (
              <li key={p.identity} className={onStage ? 'on-stage' : undefined}>
                <Thumb trackRef={camera} name={name} />
                <span className="studio-person">
                  <strong>{name}</strong>
                  <small>{onStage ? t('studio.onStage') : t('studio.waiting')}</small>
                </span>
                <span className="studio-person-actions">
                  <button
                    type="button"
                    className={onStage ? 'btn tonal small' : 'btn small'}
                    onClick={() => toggleStage(p.identity)}
                  >
                    <Icon name={onStage ? 'arrow_downward' : 'arrow_upward'} size={16} />
                    {onStage ? t('studio.removeFromStage') : t('studio.addToStage')}
                  </button>
                  {sharing.has(p.identity) && (
                    <button
                      type="button"
                      className="btn text small"
                      aria-pressed={state.screen === p.identity}
                      onClick={() => toggleScreen(p.identity)}
                    >
                      <Icon name="present_to_all" size={16} />
                      {state.screen === p.identity ? t('studio.hideScreen') : t('studio.showScreen')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** Someone invited to the show: they see what goes out and whether they are in it. */
function Guest() {
  const t = useT();
  const room = useRoomContext();
  const state = useStudioState();
  const tracks = useStudioTracks();
  const onStage = state.stage.includes(room.localParticipant.identity);
  return (
    <div className="studio-main">
      <div className="studio-preview">
        <StudioCanvas state={state} tracks={tracks} emptyText={t('studio.emptyStageGuest')} />
      </div>
      <p className={onStage ? 'studio-status live' : 'studio-status'} role="status">
        <Icon name={onStage ? 'live_tv' : 'schedule'} size={18} />
        {onStage ? t('studio.youAreOnStage') : t('studio.youAreBackstage')}
      </p>
    </div>
  );
}

export function StudioMain(props: {
  producer: boolean;
  control: StudioControl;
  onPanel: () => void;
  onError: (message: string) => void;
}) {
  return props.producer ? (
    <Producer control={props.control} onPanel={props.onPanel} onError={props.onError} />
  ) : (
    <Guest />
  );
}

const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** Side panel: banners, name tags and the show's look. */
export function StudioPanel(props: { control: StudioControl }) {
  const t = useT();
  const { state, change } = props.control;
  const [text, setText] = useState('');
  const [style, setStyle] = useState<StudioBanner['style']>('bar');
  const [brand, setBrand] = useState(state.brand);
  const brandKey = JSON.stringify(state.brand);
  useEffect(() => setBrand(JSON.parse(brandKey) as StudioState['brand']), [brandKey]);

  function addBanner(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || state.banners.length >= MAX_BANNERS) return;
    const id = newId();
    change((s) => ({ ...s, banners: [...s.banners, { id, text: value, style }], banner: id }));
    setText('');
  }

  return (
    <div className="meet-panel-body studio-panel">
      <h4>{t('studio.banners')}</h4>
      <form className="studio-banner-form" onSubmit={addBanner}>
        <textarea
          value={text}
          maxLength={MAX_BANNER_CHARS}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('studio.bannerPlaceholder')}
          aria-label={t('studio.bannerText')}
        />
        <div className="row">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as StudioBanner['style'])}
            aria-label={t('studio.bannerStyle')}
          >
            <option value="bar">{t('studio.bannerBar')}</option>
            <option value="ticker">{t('studio.bannerTicker')}</option>
          </select>
          <button className="btn small" disabled={!text.trim() || state.banners.length >= MAX_BANNERS}>
            <Icon name="add" size={16} />
            {t('studio.addBanner')}
          </button>
        </div>
      </form>
      {state.banners.length === 0 ? (
        <p className="muted">{t('studio.noBanners')}</p>
      ) : (
        <ul className="studio-banner-list">
          {state.banners.map((b) => {
            const shown = state.banner === b.id;
            return (
              <li key={b.id} className={shown ? 'shown' : undefined}>
                <button
                  type="button"
                  className="studio-banner-pick"
                  aria-pressed={shown}
                  onClick={() => change((s) => ({ ...s, banner: shown ? null : b.id }))}
                >
                  <span>{b.text}</span>
                  <small>
                    {b.style === 'ticker' ? t('studio.bannerTicker') : t('studio.bannerBar')} ·{' '}
                    {shown ? t('studio.bannerShown') : t('studio.bannerShow')}
                  </small>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={t('studio.deleteBanner')}
                  onClick={() =>
                    change((s) => ({
                      ...s,
                      banners: s.banners.filter((x) => x.id !== b.id),
                      banner: s.banner === b.id ? null : s.banner,
                    }))
                  }
                >
                  <Icon name="delete" size={18} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h4>{t('studio.look')}</h4>
      <label className="switch">
        <input
          type="checkbox"
          checked={state.names}
          onChange={(e) => change((s) => ({ ...s, names: e.target.checked }))}
        />
        <span>{t('studio.showNames')}</span>
      </label>
      <form
        className="studio-brand"
        onSubmit={(e) => {
          e.preventDefault();
          const logo = brand.logo?.trim() || null;
          if (logo && !logo.startsWith('https://')) return;
          change((s) => ({ ...s, brand: { ...brand, logo } }));
        }}
      >
        <label>
          {t('studio.accentColor')}
          <input
            type="color"
            value={brand.color}
            onChange={(e) => setBrand({ ...brand, color: e.target.value })}
          />
        </label>
        <label>
          {t('studio.backgroundColor')}
          <input
            type="color"
            value={brand.background}
            onChange={(e) => setBrand({ ...brand, background: e.target.value })}
          />
        </label>
        <label className="wide">
          {t('studio.logo')}
          <input
            className="field"
            type="url"
            inputMode="url"
            value={brand.logo ?? ''}
            placeholder="https://…"
            onChange={(e) => setBrand({ ...brand, logo: e.target.value })}
          />
          <small className="muted">{t('studio.logoHint')}</small>
        </label>
        <button className="btn small" disabled={JSON.stringify(brand) === brandKey}>
          {t('studio.applyLook')}
        </button>
      </form>
    </div>
  );
}
