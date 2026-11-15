'use client';

import {
  type TrackReferenceOrPlaceholder,
  VideoTrack,
  isTrackReference,
  useTracks,
} from '@livekit/components-react';
import { type Participant, RoomEvent, Track } from 'livekit-client';
import { type CSSProperties, useEffect, useState } from 'react';
import { displayName } from '@/lib/a11y';
import { useLocale } from '@/i18n/client';
import {
  EMPTY_STUDIO,
  type StudioClockSource,
  type StudioSceneBody,
  type StudioSource,
  type StudioState,
  formatClock,
  layoutShape,
  sortedSources,
} from '@/lib/studio';
import { useRoomState } from '../meet/useRoomState';

/** Full studio state (scenes + program/preview) from room metadata. */
export function useStudioState(): StudioState {
  return useRoomState().studio ?? EMPTY_STUDIO;
}

/** Cameras and screen shares of everyone in the room, refreshed as people come and go. */
export function useStudioTracks(): TrackReferenceOrPlaceholder[] {
  return useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
}

const cameraOf = (tracks: TrackReferenceOrPlaceholder[], identity: string) =>
  tracks.find((t) => t.participant.identity === identity && t.source === Track.Source.Camera);

const screenOf = (tracks: TrackReferenceOrPlaceholder[], identity: string | null) =>
  identity === null
    ? undefined
    : tracks.find(
        (t) =>
          t.participant.identity === identity && t.source === Track.Source.ScreenShare && isTrackReference(t),
      );

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

function nameOf(p: Participant): string {
  return displayName(p);
}

function Person(props: { trackRef: TrackReferenceOrPlaceholder; names: boolean; speaking: boolean }) {
  const { trackRef } = props;
  const name = nameOf(trackRef.participant);
  const video = isTrackReference(trackRef) && !trackRef.publication.isMuted;
  return (
    <div className={props.speaking ? 'studio-tile speaking' : 'studio-tile'}>
      {video ? (
        <VideoTrack trackRef={trackRef} className="studio-video" />
      ) : (
        <span className="studio-avatar" aria-hidden>
          {initials(name)}
        </span>
      )}
      {props.names && <span className="studio-name">{name}</span>}
    </div>
  );
}

function Screen(props: { trackRef: TrackReferenceOrPlaceholder }) {
  if (!isTrackReference(props.trackRef)) return null;
  return (
    <div className="studio-tile screen">
      <VideoTrack trackRef={props.trackRef} className="studio-video contain" />
    </div>
  );
}

/** Columns that keep an even grid of `n` people near 16:9. */
const gridColumns = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : 3);

/**
 * What goes live: the people the producer put on stage, laid out, with name tags, the brand
 * (background, colour, logo) and the banner on screen. Everyone backstage stays out of it.
 */
function ClockLayer({ source, box }: { source: StudioClockSource; box: CSSProperties }) {
  const locale = useLocale();
  const loc = locale === 'en' ? 'en-US' : locale === 'es' ? 'es-ES' : 'pt-BR';
  const [label, setLabel] = useState(() => formatClock(source.format, new Date(), loc));
  useEffect(() => {
    const tick = () => setLabel(formatClock(source.format, new Date(), loc));
    tick();
    const ms = source.format === 'date' ? 30_000 : 1000;
    const id = window.setInterval(tick, ms);
    return () => window.clearInterval(id);
  }, [source.format, loc]);
  return (
    <div
      className="studio-source text clock"
      style={{
        ...box,
        color: source.color,
        background: source.background,
        textAlign: source.align,
        fontSize: `clamp(12px, ${source.size * 0.12}cqw, ${source.size}px)`,
      }}
    >
      <span>{label}</span>
    </div>
  );
}

function SourceLayer({ source }: { source: StudioSource }) {
  const box = {
    left: `${source.box.x}%`,
    top: `${source.box.y}%`,
    width: `${source.box.w}%`,
    height: `${source.box.h}%`,
    opacity: source.opacity,
    zIndex: 20 + source.z,
  } as CSSProperties;
  if (source.type === 'browser') {
    const ready = source.url.startsWith('https://') && source.url.length > 8;
    return (
      <div className="studio-source browser" style={box}>
        {ready ? (
          <iframe
            title={source.name}
            src={source.url}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            allow={source.muted ? undefined : 'autoplay; encrypted-media'}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="studio-source-placeholder">{source.name}</span>
        )}
      </div>
    );
  }
  if (source.type === 'image') {
    const ready = source.url.startsWith('https://') && source.url.length > 8;
    return (
      <div className="studio-source image" style={box}>
        {ready ? (
          // eslint-disable-next-line @next/next/no-img-element -- producer-chosen https image
          <img src={source.url} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="studio-source-placeholder">{source.name}</span>
        )}
      </div>
    );
  }
  if (source.type === 'clock') {
    return <ClockLayer source={source} box={box} />;
  }
  return (
    <div
      className="studio-source text"
      style={{
        ...box,
        color: source.color,
        background: source.background,
        textAlign: source.align,
        fontSize: `clamp(12px, ${source.size * 0.12}cqw, ${source.size}px)`,
      }}
    >
      <span>{source.text}</span>
    </div>
  );
}

export function StudioCanvas(props: {
  state: StudioSceneBody;
  tracks: TrackReferenceOrPlaceholder[];
  /** The recorder's page fills the whole window; elsewhere it keeps 16:9. */
  fill?: boolean;
  emptyText?: string;
  /** Soft fade when Program updates after a fade transition. */
  fadeKey?: string;
}) {
  const { state, tracks } = props;
  const shape = layoutShape(state.layout);
  const people = state.stage
    .map((id) => cameraOf(tracks, id))
    .filter((t): t is TrackReferenceOrPlaceholder => t !== undefined)
    .slice(0, shape.max);
  const screen = screenOf(tracks, state.screen);
  const banner = state.banners.find((b) => b.id === state.banner) ?? null;
  const speaking = (t: TrackReferenceOrPlaceholder) => t.participant.isSpeaking;
  const style = {
    '--studio-accent': state.brand.color,
    '--studio-bg': state.brand.background,
  } as CSSProperties;

  let body;
  if (screen && shape.screenFirst) {
    body =
      state.layout === 'pip' ? (
        <div className="studio-layout pip">
          <Screen trackRef={screen} />
          {people.length > 0 && (
            <div className="studio-pip">
              {people.slice(0, 2).map((p) => (
                <Person
                  key={p.participant.identity}
                  trackRef={p}
                  names={state.names}
                  speaking={speaking(p)}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={people.length > 0 ? 'studio-layout side' : 'studio-layout solo'}>
          <Screen trackRef={screen} />
          {people.length > 0 && (
            <div className="studio-aside">
              {people.map((p) => (
                <Person
                  key={p.participant.identity}
                  trackRef={p}
                  names={state.names}
                  speaking={speaking(p)}
                />
              ))}
            </div>
          )}
        </div>
      );
  } else if (state.layout === 'leader' && people.length > 1) {
    body = (
      <div className="studio-layout side">
        <Person trackRef={people[0]} names={state.names} speaking={speaking(people[0])} />
        <div className="studio-aside">
          {people.slice(1).map((p) => (
            <Person key={p.participant.identity} trackRef={p} names={state.names} speaking={speaking(p)} />
          ))}
        </div>
      </div>
    );
  } else {
    const shown = screen && state.layout === 'grid' ? [screen, ...people] : people;
    body =
      shown.length === 0 ? (
        <div className="studio-layout empty">{props.emptyText && <p>{props.emptyText}</p>}</div>
      ) : (
        <div
          className="studio-layout grid"
          style={{ '--studio-cols': gridColumns(shown.length) } as CSSProperties}
        >
          {shown.map((t) =>
            t.source === Track.Source.ScreenShare ? (
              <Screen key={`screen-${t.participant.identity}`} trackRef={t} />
            ) : (
              <Person key={t.participant.identity} trackRef={t} names={state.names} speaking={speaking(t)} />
            ),
          )}
        </div>
      );
  }

  const layers = sortedSources(state);

  return (
    <div
      key={props.fadeKey}
      className={props.fill ? 'studio-canvas fill' : 'studio-canvas'}
      style={style}
      data-fade={props.fadeKey ? '' : undefined}
    >
      {body}
      {layers.map((src) => (
        <SourceLayer key={src.id} source={src} />
      ))}
      {state.brand.logo && (
        // eslint-disable-next-line @next/next/no-img-element -- any https logo the producer chose
        <img className="studio-logo" src={state.brand.logo} alt="" referrerPolicy="no-referrer" />
      )}
      {banner && (
        <div className={`studio-banner ${banner.style}`}>
          <span>{banner.text}</span>
        </div>
      )}
    </div>
  );
}
