'use client';

import type { BackgroundProcessorWrapper } from '@livekit/track-processors';
import { type LocalVideoTrack, type Room, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import {
  BACKGROUNDS,
  BACKGROUND_ASSETS,
  BACKGROUND_STORAGE_KEY,
  type BackgroundChoice,
  findBackground,
  switchOptions,
} from '@/lib/backgrounds';
import { Icon } from './ui/Icon';

function cameraTrack(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as
    | LocalVideoTrack
    | undefined;
}

/** The processing library (and its WebAssembly model) loads only when someone picks an effect. */
export function useBackground(room: Room) {
  const processor = useRef<BackgroundProcessorWrapper | null>(null);
  const [choice, setChoice] = useState<BackgroundChoice>(() =>
    findBackground(
      typeof window === 'undefined' ? null : window.localStorage.getItem(BACKGROUND_STORAGE_KEY),
    ),
  );
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);

  const applyTo = useCallback(async (track: LocalVideoTrack | undefined, next: BackgroundChoice) => {
    if (!track) return;
    if (next.mode === 'disabled') {
      if (track.getProcessor()) await track.stopProcessor();
      return;
    }
    const lib = await import('@livekit/track-processors');
    if (!lib.supportsBackgroundProcessors()) {
      setSupported(false);
      return;
    }
    const options = switchOptions(next);
    if (processor.current && track.getProcessor() === processor.current) {
      await processor.current.switchTo(options);
    } else {
      processor.current = lib.BackgroundProcessor({ ...options, assetPaths: BACKGROUND_ASSETS });
      await track.setProcessor(processor.current);
    }
  }, []);

  const select = useCallback(
    async (next: BackgroundChoice) => {
      setChoice(next);
      window.localStorage.setItem(BACKGROUND_STORAGE_KEY, next.id);
      setBusy(true);
      try {
        await applyTo(cameraTrack(room), next);
      } finally {
        setBusy(false);
      }
    },
    [applyTo, room],
  );

  useEffect(() => {
    const reapply = () => {
      if (choice.mode !== 'disabled') void applyTo(cameraTrack(room), choice).catch(() => undefined);
    };
    reapply();
    room.on(RoomEvent.LocalTrackPublished, reapply);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, reapply);
    };
  }, [room, choice, applyTo]);

  return { choice, select, supported, busy };
}

export type BackgroundControl = ReturnType<typeof useBackground>;

export function BackgroundPanel({ background }: { background: BackgroundControl }) {
  const t = useT();
  const { choice, select, supported, busy } = background;
  if (!supported) return <p className="muted">{t('room.backgrounds.unsupported')}</p>;
  return (
    <>
      <p className="muted">{busy ? t('room.backgrounds.applying') : t('room.backgrounds.preview')}</p>
      <div className="effects-grid" role="radiogroup" aria-label={t('room.backgrounds.group')}>
        {BACKGROUNDS.map((b) => (
          <button
            key={b.id}
            role="radio"
            aria-checked={choice.id === b.id}
            className={choice.id === b.id ? 'effect active' : 'effect'}
            onClick={() => void select(b)}
            disabled={busy}
          >
            <span
              className="effect-swatch"
              aria-hidden
              style={b.imagePath ? { backgroundImage: `url(${b.imagePath})` } : undefined}
            >
              {b.mode === 'disabled' && <Icon name="block" />}
              {b.mode === 'background-blur' && (
                <Icon name="blur_on" size={b.blurRadius && b.blurRadius > 10 ? 28 : 22} />
              )}
            </span>
            <span>{t(b.labelKey)}</span>
          </button>
        ))}
      </div>
    </>
  );
}
