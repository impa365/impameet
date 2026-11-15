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
  type StudioBrand,
  type StudioLayout,
  type StudioScene,
  type StudioSource,
  type StudioState,
  addScene,
  addSourceToPreview,
  copyProgramToPreview,
  cutPreviewToProgram,
  deleteScene,
  duplicateScene,
  ensureDirectorPair,
  parseStudio,
  previewScene,
  programScene,
  removeSourceFromPreview,
  renameScene,
  setPreviewScene,
  setTransition,
  updatePreview,
  updateSourceInPreview,
} from '@/lib/studio';
import { ApiError, api } from '../api';
import { Icon } from '../ui/Icon';
import { StudioCanvas, useStudioState, useStudioTracks } from './StudioCanvas';
import { StudioSourcesPanel } from './StudioSources';

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
  program: StudioScene;
  preview: StudioScene;
  /** Edit the Preview (draft) only — does not change what is on air until goLive. */
  changePreview: (edit: (scene: StudioScene) => StudioScene) => void;
  /** Copy Preview → Program (cut/fade to air). */
  goLive: () => void;
  loadPreview: (sceneId: string) => void;
  newScene: () => void;
  rename: (sceneId: string, name: string) => void;
  removeScene: (sceneId: string) => void;
  duplicate: (sceneId: string) => void;
  pullProgram: () => void;
  setTransitionMode: (mode: 'cut' | 'fade') => void;
  addSource: (source: StudioSource) => void;
  patchSource: (id: string, patch: Partial<StudioSource>) => void;
  removeSource: (id: string) => void;
}

/**
 * The producer's handle: Preview edits are drafted locally then saved; Program is what guests
 * and the recorder see. goLive cuts Preview into Program.
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
  const state = ensureDirectorPair(draft ?? live);
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

  const save = useCallback(
    (nextRaw: StudioState) => {
      const here = new Set([room.localParticipant.identity, ...room.remoteParticipants.keys()]);
      const cleaned = parseStudio({
        ...nextRaw,
        scenes: nextRaw.scenes.map((sc) => ({
          ...sc,
          stage: sc.stage.filter((id) => here.has(id)),
          screen: sc.screen && here.has(sc.screen) ? sc.screen : null,
        })),
      });
      const next = ensureDirectorPair(cleaned);
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

  const changePreview = useCallback(
    (edit: (scene: StudioScene) => StudioScene) => {
      save(updatePreview(stateRef.current, edit));
    },
    [save],
  );

  const goLive = useCallback(() => {
    save(cutPreviewToProgram(stateRef.current));
  }, [save]);

  const loadPreview = useCallback(
    (sceneId: string) => {
      save(setPreviewScene(stateRef.current, sceneId));
    },
    [save],
  );

  const newScene = useCallback(() => {
    save(addScene(stateRef.current));
  }, [save]);

  const rename = useCallback(
    (sceneId: string, name: string) => {
      save(renameScene(stateRef.current, sceneId, name));
    },
    [save],
  );

  const removeScene = useCallback(
    (sceneId: string) => {
      save(deleteScene(stateRef.current, sceneId));
    },
    [save],
  );

  const duplicate = useCallback(
    (sceneId: string) => {
      save(duplicateScene(stateRef.current, sceneId));
    },
    [save],
  );

  const pullProgram = useCallback(() => {
    save(copyProgramToPreview(stateRef.current));
  }, [save]);

  const setTransitionMode = useCallback(
    (mode: 'cut' | 'fade') => {
      save(setTransition(stateRef.current, mode));
    },
    [save],
  );

  const addSource = useCallback(
    (source: StudioSource) => {
      save(addSourceToPreview(stateRef.current, source));
    },
    [save],
  );

  const patchSource = useCallback(
    (id: string, patch: Partial<StudioSource>) => {
      save(updateSourceInPreview(stateRef.current, id, patch));
    },
    [save],
  );

  const removeSource = useCallback(
    (id: string) => {
      save(removeSourceFromPreview(stateRef.current, id));
    },
    [save],
  );

  return {
    state,
    program: programScene(state),
    preview: previewScene(state),
    changePreview,
    goLive,
    loadPreview,
    newScene,
    rename,
    removeScene,
    duplicate,
    pullProgram,
    setTransitionMode,
    addSource,
    patchSource,
    removeSource,
  };
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

/** The producer's desk: Program (on air) + Preview (draft), then backstage for the draft. */
function Producer(props: {
  control: StudioControl;
  onPanel: () => void;
  onLive?: () => void;
  onAir: boolean;
  onError: (message: string) => void;
}) {
  const t = useT();
  const {
    state,
    program,
    preview,
    changePreview,
    goLive,
    loadPreview,
    newScene,
    rename,
    removeScene,
    duplicate,
    pullProgram,
    setTransitionMode,
  } = props.control;
  const tracks = useStudioTracks();
  const people = useParticipants().filter((p) => p.attributes?.[CAPTIONER_ATTRIBUTE] !== 'captions');
  const sharing = new Set(
    tracks
      .filter((r) => r.source === Track.Source.ScreenShare && isTrackReference(r))
      .map((r) => r.participant.identity),
  );
  const bodyKey = (s: StudioScene) =>
    JSON.stringify({
      layout: s.layout,
      stage: s.stage,
      screen: s.screen,
      banners: s.banners,
      banner: s.banner,
      names: s.names,
      brand: s.brand,
      sources: s.sources,
    });
  const dirty = bodyKey(program) !== bodyKey(preview);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
          return;
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (dirty) goLive();
        return;
      }
      if (!(e.ctrlKey || e.metaKey) && !e.altKey && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const sc = state.scenes[idx];
        if (sc) {
          e.preventDefault();
          loadPreview(sc.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, goLive, loadPreview, state.scenes]);

  function toggleStage(identity: string) {
    if (!preview.stage.includes(identity) && preview.stage.length >= MAX_ON_STAGE) {
      props.onError(t('studio.stageFull', { max: MAX_ON_STAGE }));
      return;
    }
    changePreview((s) => ({
      ...s,
      stage: s.stage.includes(identity) ? s.stage.filter((x) => x !== identity) : [...s.stage, identity],
    }));
  }

  function toggleScreen(identity: string) {
    changePreview((s) =>
      s.screen === identity
        ? { ...s, screen: null, layout: s.layout === 'screen' || s.layout === 'pip' ? 'grid' : s.layout }
        : { ...s, screen: identity, layout: s.layout === 'pip' ? 'pip' : 'screen' },
    );
  }

  return (
    <div className="studio-main producer">
      <div className="studio-director" aria-label={t('studio.director')}>
        <section className="studio-monitor">
          <header className="studio-monitor-head">
            <span className="studio-pill live">{t('studio.program')}</span>
            <small className="muted">{program.name}</small>
          </header>
          <div className="studio-preview">
            <StudioCanvas
              state={program}
              tracks={tracks}
              emptyText={t('studio.emptyProgram')}
              fadeKey={state.transition === 'fade' ? bodyKey(program) : undefined}
            />
          </div>
        </section>
        <section className="studio-monitor">
          <header className="studio-monitor-head">
            <span className="studio-pill draft">{t('studio.preview')}</span>
            <small className="muted">{preview.name}</small>
            <select
              className="studio-transition"
              aria-label={t('studio.transition')}
              value={state.transition}
              onChange={(e) => setTransitionMode(e.target.value as 'cut' | 'fade')}
            >
              <option value="cut">{t('studio.transitionCut')}</option>
              <option value="fade">{t('studio.transitionFade')}</option>
            </select>
            <button
              type="button"
              className="btn text small"
              onClick={() => pullProgram()}
              title={t('studio.pullProgramHelp')}
            >
              <Icon name="content_copy" size={16} />
              {t('studio.pullProgram')}
            </button>
            <button
              type="button"
              className="btn small"
              disabled={!dirty}
              onClick={() => goLive()}
              title={t('studio.goLiveHelp')}
            >
              <Icon name="play_arrow" size={18} />
              {t('studio.goLive')}
            </button>
          </header>
          <div className="studio-preview">
            <StudioCanvas state={preview} tracks={tracks} emptyText={t('studio.emptyStage')} />
          </div>
        </section>
      </div>

      <div className="studio-scenes" role="toolbar" aria-label={t('studio.scenes')}>
        {state.scenes.map((sc) => (
          <span key={sc.id} className="studio-scene-chip">
            <button
              type="button"
              className={
                sc.id === preview.id
                  ? 'studio-scene-btn on'
                  : sc.id === program.id
                    ? 'studio-scene-btn program'
                    : 'studio-scene-btn'
              }
              onClick={() => loadPreview(sc.id)}
              onDoubleClick={() => {
                const name = window.prompt(t('studio.renameScene'), sc.name);
                if (name) rename(sc.id, name);
              }}
              aria-pressed={sc.id === preview.id}
              title={t('studio.sceneHint')}
            >
              {sc.name}
              {sc.id === program.id && <small>{t('studio.onAirShort')}</small>}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={t('studio.duplicateScene')}
              title={t('studio.duplicateScene')}
              onClick={() => duplicate(sc.id)}
            >
              <Icon name="content_copy" size={14} />
            </button>
            {sc.id !== program.id && state.scenes.length > 2 && (
              <button
                type="button"
                className="icon-btn"
                aria-label={t('studio.deleteScene')}
                onClick={() => removeScene(sc.id)}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </span>
        ))}
        <button type="button" className="btn text small" onClick={() => newScene()}>
          <Icon name="add" size={16} />
          {t('studio.addScene')}
        </button>
      </div>

      <div className="studio-toolbar" role="toolbar" aria-label={t('studio.layoutTitle')}>
        <div className="studio-layouts" role="radiogroup" aria-label={t('studio.layoutTitle')}>
          {STUDIO_LAYOUTS.map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={preview.layout === l}
              className={preview.layout === l ? 'studio-layout-btn on' : 'studio-layout-btn'}
              onClick={() => changePreview((s) => ({ ...s, layout: l }))}
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
        <span className="studio-actions">
          <button type="button" className="btn tonal small" onClick={props.onPanel}>
            <Icon name="title" size={18} />
            {t('studio.bannersAndBrand')}
          </button>
          {props.onLive && (
            <button type="button" className="btn danger small" onClick={props.onLive}>
              <Icon name="sensors" size={18} />
              {props.onAir ? t('live.menuOnAir') : t('live.menu')}
            </button>
          )}
        </span>
      </div>
      <section className="studio-backstage" aria-label={t('studio.backstage')}>
        <h4>
          {t('studio.backstage')} <small className="muted">{t('studio.backstageHint')}</small>
        </h4>
        <ul>
          {people.map((p) => {
            const name = displayName(p, t('room.aiAssistant'));
            const onStage = preview.stage.includes(p.identity);
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
                      aria-pressed={preview.screen === p.identity}
                      onClick={() => toggleScreen(p.identity)}
                    >
                      <Icon name="present_to_all" size={16} />
                      {preview.screen === p.identity ? t('studio.hideScreen') : t('studio.showScreen')}
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

/** Someone invited to the show: they see Program (on air) only. */
function Guest() {
  const t = useT();
  const room = useRoomContext();
  const studio = useStudioState();
  const program = programScene(studio);
  const tracks = useStudioTracks();
  const onStage = program.stage.includes(room.localParticipant.identity);
  return (
    <div className="studio-main">
      <div className="studio-preview">
        <StudioCanvas state={program} tracks={tracks} emptyText={t('studio.emptyStageGuest')} />
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
  onLive?: () => void;
  onAir: boolean;
  onError: (message: string) => void;
}) {
  return props.producer ? (
    <Producer
      control={props.control}
      onPanel={props.onPanel}
      onLive={props.onLive}
      onAir={props.onAir}
      onError={props.onError}
    />
  ) : (
    <Guest />
  );
}

const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

/** Side panel: banners, name tags and look for the Preview (draft) scene. */
export function StudioPanel(props: { control: StudioControl }) {
  const t = useT();
  const { preview, changePreview } = props.control;
  const [text, setText] = useState('');
  const [style, setStyle] = useState<StudioBanner['style']>('bar');
  const [brand, setBrand] = useState(preview.brand);
  const brandKey = JSON.stringify(preview.brand);
  useEffect(() => setBrand(JSON.parse(brandKey) as StudioBrand), [brandKey]);

  function addBanner(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || preview.banners.length >= MAX_BANNERS) return;
    const id = newId();
    changePreview((s) => ({ ...s, banners: [...s.banners, { id, text: value, style }], banner: id }));
    setText('');
  }

  return (
    <div className="meet-panel-body studio-panel">
      <p className="muted small-print">{t('studio.panelPreviewHint')}</p>
      <StudioSourcesPanel control={props.control} />
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
          <button className="btn small" disabled={!text.trim() || preview.banners.length >= MAX_BANNERS}>
            <Icon name="add" size={16} />
            {t('studio.addBanner')}
          </button>
        </div>
      </form>
      {preview.banners.length === 0 ? (
        <p className="muted">{t('studio.noBanners')}</p>
      ) : (
        <ul className="studio-banner-list">
          {preview.banners.map((b) => {
            const shown = preview.banner === b.id;
            return (
              <li key={b.id} className={shown ? 'shown' : undefined}>
                <button
                  type="button"
                  className="studio-banner-pick"
                  aria-pressed={shown}
                  onClick={() => changePreview((s) => ({ ...s, banner: shown ? null : b.id }))}
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
                    changePreview((s) => ({
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
          checked={preview.names}
          onChange={(e) => changePreview((s) => ({ ...s, names: e.target.checked }))}
        />
        <span>{t('studio.showNames')}</span>
      </label>
      <form
        className="studio-brand"
        onSubmit={(e) => {
          e.preventDefault();
          const logo = brand.logo?.trim() || null;
          if (logo && !logo.startsWith('https://')) return;
          changePreview((s) => ({ ...s, brand: { ...brand, logo } }));
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
