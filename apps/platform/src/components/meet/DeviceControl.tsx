'use client';

import { useMediaDeviceSelect, usePersistentUserChoices, useTrackToggle } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
import { useDismiss } from '../ui/useDismiss';

function DeviceList({
  kind,
  title,
  onPicked,
}: {
  kind: MediaDeviceKind;
  title: string;
  onPicked: (id: string) => void;
}) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind });
  if (devices.length === 0) return null;
  return (
    <>
      <p className="menu-label">{title}</p>
      {devices.map((d, i) => (
        <button
          key={d.deviceId || i}
          role="menuitemradio"
          aria-checked={d.deviceId === activeDeviceId}
          className="menu-item"
          onClick={() => {
            void setActiveMediaDevice(d.deviceId).catch(() => undefined);
            onPicked(d.deviceId);
          }}
        >
          <span className="menu-check">
            {d.deviceId === activeDeviceId && <Icon name="check" size={18} />}
          </span>
          <span className="menu-text">{d.label || `${title} ${i + 1}`}</span>
        </button>
      ))}
    </>
  );
}

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

/** Meet's microphone / camera control: the round toggle with a device chevron beside it. */
export function DeviceControl({ kind, onEffects }: { kind: 'audio' | 'video'; onEffects?: () => void }) {
  const t = useT();
  const audio = kind === 'audio';
  const { saveAudioInputEnabled, saveVideoInputEnabled, saveAudioInputDeviceId, saveVideoInputDeviceId } =
    usePersistentUserChoices();
  const onChange = useCallback(
    (enabled: boolean, userInitiated: boolean) => {
      if (!userInitiated) return;
      if (audio) saveAudioInputEnabled(enabled);
      else saveVideoInputEnabled(enabled);
    },
    [audio, saveAudioInputEnabled, saveVideoInputEnabled],
  );
  const { enabled, pending, toggle } = useTrackToggle({
    source: audio ? Track.Source.Microphone : Track.Source.Camera,
    onChange,
  });
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);

  const label = audio
    ? `${enabled ? t('room.device.micOff') : t('room.device.micOn')} (Ctrl + D)`
    : `${enabled ? t('room.device.camOff') : t('room.device.camOn')} (Ctrl + E)`;
  const settings = audio ? t('room.device.audioSettings') : t('room.device.videoSettings');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || isTyping(e)) return;
      if (e.key.toLowerCase() !== (audio ? 'd' : 'e')) return;
      e.preventDefault();
      void toggle().catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [audio, toggle]);

  return (
    <div ref={anchor} className={enabled ? 'split' : 'split off'}>
      <button
        className="split-chevron"
        aria-label={settings}
        aria-expanded={open}
        data-tip={settings}
        onClick={() => setOpen(!open)}
      >
        <Icon name="keyboard_arrow_up" size={20} />
      </button>
      <button
        className="split-face"
        aria-label={label}
        data-tip={label}
        disabled={pending}
        onClick={() => void toggle().catch(() => undefined)}
      >
        <Icon name={audio ? (enabled ? 'mic' : 'mic_off') : enabled ? 'videocam' : 'videocam_off'} />
      </button>
      {open && (
        <div className="menu up" role="menu">
          {audio ? (
            <>
              <DeviceList
                kind="audioinput"
                title={t('room.device.microphone')}
                onPicked={saveAudioInputDeviceId}
              />
              <DeviceList kind="audiooutput" title={t('room.device.speaker')} onPicked={() => undefined} />
            </>
          ) : (
            <>
              <DeviceList
                kind="videoinput"
                title={t('room.device.camera')}
                onPicked={saveVideoInputDeviceId}
              />
              {onEffects && (
                <button
                  className="menu-item divided"
                  onClick={() => {
                    setOpen(false);
                    onEffects();
                  }}
                >
                  <span className="menu-check">
                    <Icon name="background_replace" size={18} />
                  </span>
                  <span className="menu-text">{t('room.device.applyEffects')}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
