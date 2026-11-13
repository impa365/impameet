'use client';

import {
  type LocalUserChoices,
  useMediaDevices,
  usePersistentUserChoices,
  usePreviewTracks,
} from '@livekit/components-react';
import { type LocalVideoTrack, Track, VideoPresets } from 'livekit-client';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { A11Y_STORAGE_KEY, parseA11yPrefs } from '@/lib/a11y';
import { wantsAssistance } from '@/lib/assisted-join';
import { DEFAULT_WAKE_WORD } from '@/lib/voice-commands';
import { LanguageSwitcher } from '../LanguageSwitcher';
import { Icon } from '../ui/Icon';
import { AssistedJoin } from './AssistedJoin';
import { avatarColor, initial } from './Avatar';

function DevicePicker(props: {
  kind: MediaDeviceKind;
  label: string;
  icon: 'mic' | 'videocam';
  value: string;
  onChange: (id: string) => void;
}) {
  const devices = useMediaDevices({ kind: props.kind });
  if (devices.length === 0) return null;
  return (
    <label className="device-pick">
      <Icon name={props.icon} size={18} />
      <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${props.label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Meet's green room: your camera on the left, "ready to join?" on the right. */
export function MeetPrejoin(props: {
  roomName: string;
  userName: string | null;
  busy: boolean;
  error: string;
  extra?: ReactNode;
  /** `assisted` when the person came in through the guided entry (the lobby then speaks too). */
  onJoin: (choices: LocalUserChoices, assisted: boolean) => void;
}) {
  const t = useT();
  const [assisted, setAssisted] = useState(false);
  // The saved choices live in this browser: rendering them on the server would show stale
  // microphone and camera states (hydration keeps the server's attributes).
  const [mounted, setMounted] = useState(false);
  const [wakeWord, setWakeWord] = useState(DEFAULT_WAKE_WORD);
  useEffect(() => {
    setMounted(true);
    setWakeWord(parseA11yPrefs(window.localStorage.getItem(A11Y_STORAGE_KEY)).wakeWord);
    if (wantsAssistance(window.location.search)) setAssisted(true);
  }, []);
  const {
    userChoices,
    saveAudioInputEnabled,
    saveVideoInputEnabled,
    saveAudioInputDeviceId,
    saveVideoInputDeviceId,
    saveUsername,
  } = usePersistentUserChoices({
    defaults: { username: props.userName ?? '', videoEnabled: true, audioEnabled: true },
  });
  const [audioEnabled, setAudioEnabled] = useState(userChoices.audioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(userChoices.videoEnabled);
  const [audioDeviceId, setAudioDeviceId] = useState(userChoices.audioDeviceId);
  const [videoDeviceId, setVideoDeviceId] = useState(userChoices.videoDeviceId);
  const [username, setUsername] = useState(props.userName ?? userChoices.username);
  const [mediaError, setMediaError] = useState<'blocked' | 'failed' | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  const options = useMemo(
    () => ({
      audio: audioEnabled
        ? { deviceId: audioDeviceId === 'default' ? undefined : audioDeviceId || undefined }
        : false,
      video: videoEnabled
        ? {
            deviceId: videoDeviceId === 'default' ? undefined : videoDeviceId || undefined,
            resolution: VideoPresets.h720.resolution,
          }
        : false,
    }),
    [audioEnabled, videoEnabled, audioDeviceId, videoDeviceId],
  );
  const onError = useMemo(
    () => (err: Error) => setMediaError(err.name === 'NotAllowedError' ? 'blocked' : 'failed'),
    [],
  );
  const tracks = usePreviewTracks(options, onError);
  const videoTrack = tracks?.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;

  useEffect(() => {
    if (!video.current || !videoTrack) return;
    videoTrack.attach(video.current);
    return () => {
      videoTrack.detach();
    };
  }, [videoTrack]);

  useEffect(() => {
    saveAudioInputEnabled(audioEnabled);
    saveVideoInputEnabled(videoEnabled);
    saveAudioInputDeviceId(audioDeviceId);
    saveVideoInputDeviceId(videoDeviceId);
    saveUsername(username);
  }, [
    audioEnabled,
    videoEnabled,
    audioDeviceId,
    videoDeviceId,
    username,
    saveAudioInputEnabled,
    saveVideoInputEnabled,
    saveAudioInputDeviceId,
    saveVideoInputDeviceId,
    saveUsername,
  ]);

  const name = (props.userName ?? username).trim();

  function join() {
    if (!name || props.busy) return;
    props.onJoin({ username: name, audioEnabled, videoEnabled, audioDeviceId, videoDeviceId }, assisted);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    join();
  }

  if (!mounted) return <main className="green-room theme-dark" aria-busy="true" />;

  return (
    <main className="green-room theme-dark" aria-labelledby="green-title" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, right: 16 }}>
        <LanguageSwitcher compact />
      </div>
      <section className="green-preview">
        <div className="green-video">
          {videoEnabled && videoTrack ? (
            <video ref={video} muted playsInline aria-hidden />
          ) : (
            <div className="green-off">
              {name ? (
                <span className="tile-avatar" style={{ background: avatarColor(name) }}>
                  {initial(name)}
                </span>
              ) : (
                <span>{t('room.prejoin.cameraOff')}</span>
              )}
            </div>
          )}
          {name && <span className="green-name">{name}</span>}
          <div className="green-toggles">
            <button
              type="button"
              className={audioEnabled ? 'round' : 'round off'}
              aria-label={audioEnabled ? t('room.device.micOff') : t('room.device.micOn')}
              data-tip={audioEnabled ? t('room.device.micOff') : t('room.device.micOn')}
              onClick={() => setAudioEnabled(!audioEnabled)}
            >
              <Icon name={audioEnabled ? 'mic' : 'mic_off'} />
            </button>
            <button
              type="button"
              className={videoEnabled ? 'round' : 'round off'}
              aria-label={videoEnabled ? t('room.device.camOff') : t('room.device.camOn')}
              data-tip={videoEnabled ? t('room.device.camOff') : t('room.device.camOn')}
              onClick={() => setVideoEnabled(!videoEnabled)}
            >
              <Icon name={videoEnabled ? 'videocam' : 'videocam_off'} />
            </button>
          </div>
        </div>
        <div className="green-devices" key={tracks?.length ?? 0}>
          <DevicePicker
            kind="audioinput"
            label={t('room.device.microphone')}
            icon="mic"
            value={audioDeviceId}
            onChange={setAudioDeviceId}
          />
          <DevicePicker
            kind="videoinput"
            label={t('room.device.camera')}
            icon="videocam"
            value={videoDeviceId}
            onChange={setVideoDeviceId}
          />
        </div>
        {mediaError && (
          <p className="error" role="alert">
            {mediaError === 'blocked' ? t('room.prejoin.blocked') : t('room.prejoin.mediaFailed')}
          </p>
        )}
      </section>

      {assisted ? (
        <AssistedJoin
          roomName={props.roomName}
          fixedName={props.userName}
          name={username}
          onName={setUsername}
          audioEnabled={audioEnabled}
          onAudio={setAudioEnabled}
          videoEnabled={videoEnabled}
          onVideo={setVideoEnabled}
          mediaError={mediaError}
          wakeWord={wakeWord}
          busy={props.busy}
          error={props.error}
          extra={props.extra}
          onJoin={join}
          onCancel={() => setAssisted(false)}
        />
      ) : (
        <form className="green-join" onSubmit={submit}>
          <h1 id="green-title">{t('room.prejoin.ready')}</h1>
          <p className="muted">{props.roomName}</p>
          <button type="button" className="btn tonal" onClick={() => setAssisted(true)}>
            <Icon name="accessibility_new" size={18} />
            {t('room.assist.open')}
          </button>
          {props.userName === null && (
            <input
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('room.prejoin.namePlaceholder')}
              aria-label={t('room.prejoin.nameLabel')}
              maxLength={80}
              autoComplete="name"
              required
            />
          )}
          {props.extra}
          <button className="btn large" disabled={!name || props.busy}>
            {props.busy ? t('room.prejoin.joining') : t('room.prejoin.joinNow')}
          </button>
          <div className="error" role="alert">
            {props.error}
          </div>
        </form>
      )}
    </main>
  );
}
