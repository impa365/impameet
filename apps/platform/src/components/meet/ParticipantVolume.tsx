'use client';

import { useRoomContext } from '@livekit/components-react';
import { RemoteParticipant, RoomEvent, Track } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '@/i18n/client';
import {
  VOLUME_DEFAULT,
  VOLUME_MAX,
  VOLUME_MIN,
  clampVolume,
  volumeFromPercent,
  volumePercent,
} from '@/lib/participant-volume';
import { Icon } from '../ui/Icon';

type Volumes = Record<string, number>;

interface VolumeApi {
  get: (identity: string) => number;
  set: (identity: string, volume: number) => void;
}

const VolumeContext = createContext<VolumeApi | null>(null);

function applyToParticipant(participant: RemoteParticipant, volume: number) {
  participant.setVolume(volume, Track.Source.Microphone);
  participant.setVolume(volume, Track.Source.ScreenShareAudio);
}

/** Keeps per-person volumes and reapplies them when a remote audio track appears. */
export function ParticipantVolumeProvider({ children }: { children: ReactNode }) {
  const room = useRoomContext();
  const [volumes, setVolumes] = useState<Volumes>({});
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;

  const set = useCallback(
    (identity: string, volume: number) => {
      const next = clampVolume(volume);
      setVolumes((prev) => (prev[identity] === next ? prev : { ...prev, [identity]: next }));
      const participant = room.getParticipantByIdentity(identity);
      if (participant instanceof RemoteParticipant) applyToParticipant(participant, next);
    },
    [room],
  );

  const get = useCallback((identity: string) => volumes[identity] ?? VOLUME_DEFAULT, [volumes]);

  useEffect(() => {
    const onSubscribed = (
      _track: unknown,
      publication: { source: Track.Source; kind: Track.Kind },
      participant: { identity: string; isLocal: boolean },
    ) => {
      if (participant.isLocal || publication.kind !== Track.Kind.Audio) return;
      const volume = volumesRef.current[participant.identity];
      if (volume === undefined || volume === VOLUME_DEFAULT) return;
      const remote = room.getParticipantByIdentity(participant.identity);
      if (remote instanceof RemoteParticipant) {
        remote.setVolume(
          volume,
          publication.source as Track.Source.Microphone | Track.Source.ScreenShareAudio,
        );
      }
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
    };
  }, [room]);

  const api = useMemo(() => ({ get, set }), [get, set]);
  return <VolumeContext.Provider value={api}>{children}</VolumeContext.Provider>;
}

export function useParticipantVolume(): VolumeApi {
  const api = useContext(VolumeContext);
  if (!api) throw new Error('ParticipantVolumeProvider is missing');
  return api;
}

/** Optional read when the provider may be absent (e.g. tests). */
export function useParticipantVolumeOptional(): VolumeApi | null {
  return useContext(VolumeContext);
}

/**
 * Local-only volume for one remote person: 0–200%, with a mute toggle that remembers the
 * previous level. Screen readers get a clear label and percentage.
 */
export function PersonVolumeControl(props: { identity: string; name: string }) {
  const t = useT();
  const { get, set } = useParticipantVolume();
  const volume = get(props.identity);
  const percent = volumePercent(volume);
  const beforeMute = useRef(VOLUME_DEFAULT);

  const muted = volume === 0;
  const label = t('room.volume.label', { name: props.name });
  const valueText = t('room.volume.percent', { n: percent });

  return (
    <div className="person-volume">
      <button
        type="button"
        className="icon-btn"
        aria-pressed={muted}
        aria-label={
          muted ? t('room.volume.unmute', { name: props.name }) : t('room.volume.mute', { name: props.name })
        }
        title={muted ? t('room.volume.unmuteHint') : t('room.volume.muteHint')}
        onClick={() => {
          if (muted) {
            set(props.identity, beforeMute.current || VOLUME_DEFAULT);
          } else {
            beforeMute.current = volume > 0 ? volume : VOLUME_DEFAULT;
            set(props.identity, 0);
          }
        }}
      >
        <Icon name={muted ? 'volume_off' : 'volume_up'} size={20} />
      </button>
      <label className="person-volume-slider">
        <span className="sr-only">{label}</span>
        <input
          type="range"
          min={VOLUME_MIN * 100}
          max={VOLUME_MAX * 100}
          step={5}
          value={percent}
          aria-valuemin={0}
          aria-valuemax={200}
          aria-valuenow={percent}
          aria-valuetext={valueText}
          aria-label={label}
          onChange={(e) => set(props.identity, volumeFromPercent(Number(e.target.value)))}
        />
      </label>
      <span className="person-volume-value" aria-hidden>
        {percent}%
      </span>
    </div>
  );
}
