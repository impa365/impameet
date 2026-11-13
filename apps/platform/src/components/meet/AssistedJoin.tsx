'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { MAX_NAME_LENGTH, SPEECH_LANG, isJoinCommand, spokenName } from '@/lib/assisted-join';
import { Icon } from '../ui/Icon';

/** The part of the Web Speech API this page uses (not in the TypeScript DOM types yet). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Listening = 'name' | 'command' | null;

/**
 * A guided way in for people who cannot type or find small controls: spoken instructions, the
 * name said aloud and confirmed before it is used, large controls that say their state, and the
 * same consent for the microphone and camera. Nothing here records audio; recognition runs in
 * the browser (which may use its vendor's service, as the page says).
 */
export function AssistedJoin(props: {
  roomName: string;
  /** Null for guests, who say or type their name; signed-in people already have one. */
  fixedName: string | null;
  name: string;
  onName: (name: string) => void;
  audioEnabled: boolean;
  onAudio: (on: boolean) => void;
  videoEnabled: boolean;
  onVideo: (on: boolean) => void;
  mediaError: 'blocked' | 'failed' | null;
  busy: boolean;
  error: string;
  /** The room password field, when the room asks for one. */
  extra?: ReactNode;
  onJoin: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const lang = SPEECH_LANG[locale];
  const heading = useRef<HTMLHeadingElement>(null);
  const recognition = useRef<Recognition | null>(null);
  const [supported] = useState(() => recognitionCtor() !== null);
  const [listening, setListening] = useState<Listening>(null);
  const [confirmed, setConfirmed] = useState(props.fixedName !== null);
  const [status, setStatus] = useState('');
  // Screen reader users already hear the status line: they can turn the second voice off.
  const [aloud, setAloud] = useState(true);
  const aloudRef = useRef(aloud);
  aloudRef.current = aloud;
  const name = (props.fixedName ?? props.name).trim();

  const speak = useCallback(
    (text: string) => {
      setStatus(text);
      if (!aloudRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      window.speechSynthesis.speak(utterance);
    },
    [lang],
  );

  const instructions = useCallback(() => {
    const steps = [
      t('room.assist.intro', { room: props.roomName }),
      props.fixedName === null
        ? supported
          ? t('room.assist.stepNameVoice')
          : t('room.assist.stepNameType')
        : t('room.assist.stepNameKnown', { name: props.fixedName }),
      t('room.assist.stepDevices'),
      supported ? t('room.assist.stepJoinVoice') : t('room.assist.stepJoin'),
    ];
    speak(steps.join(' '));
  }, [t, props.roomName, props.fixedName, supported, speak]);

  useEffect(() => {
    heading.current?.focus();
    instructions();
    return () => {
      recognition.current?.abort();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    };
    // Only when the assisted entry opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function listen(mode: Exclude<Listening, null>) {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    recognition.current?.abort();
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? '';
      if (mode === 'name') {
        const heard = spokenName(said);
        if (!heard) return speak(t('room.assist.notUnderstood'));
        props.onName(heard);
        setConfirmed(false);
        speak(t('room.assist.heardName', { name: heard }));
      } else if (isJoinCommand(said)) {
        join();
      } else {
        speak(t('room.assist.commandNotUnderstood'));
      }
    };
    r.onerror = (e) =>
      speak(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? t('room.assist.micBlocked')
          : e.error === 'no-speech'
            ? t('room.assist.noSpeech')
            : t('room.assist.notUnderstood'),
      );
    r.onend = () => setListening(null);
    recognition.current = r;
    setListening(mode);
    setStatus(mode === 'name' ? t('room.assist.listeningName') : t('room.assist.listeningCommand'));
    r.start();
  }

  function confirmName() {
    if (!name) return speak(t('room.assist.nameMissing'));
    setConfirmed(true);
    speak(t('room.assist.nameConfirmed', { name }));
  }

  function join() {
    if (!name) return speak(t('room.assist.nameMissing'));
    if (!confirmed) return speak(t('room.assist.confirmFirst', { name }));
    speak(t('room.assist.joining'));
    props.onJoin();
  }

  const toggle = (on: boolean, label: string) =>
    `${label}: ${on ? t('room.assist.on') : t('room.assist.off')}`;

  return (
    <section className="assist" aria-labelledby="assist-title">
      <h2 id="assist-title" ref={heading} tabIndex={-1}>
        {t('room.assist.title')}
      </h2>
      <p>{t('room.assist.intro', { room: props.roomName })}</p>
      <button type="button" className="btn secondary assist-big" onClick={instructions}>
        <Icon name="volume_up" />
        {t('room.assist.repeat')}
      </button>
      <label className="switch">
        <input
          type="checkbox"
          checked={aloud}
          onChange={(e) => {
            setAloud(e.target.checked);
            if (!e.target.checked) window.speechSynthesis?.cancel();
          }}
        />
        <span>
          {t('room.assist.aloud')}
          <small>{t('room.assist.aloudHelp')}</small>
        </span>
      </label>

      {props.fixedName === null ? (
        <fieldset className="plain assist-step">
          <legend>{t('room.assist.nameLegend')}</legend>
          {supported ? (
            <button
              type="button"
              className="btn assist-big"
              aria-pressed={listening === 'name'}
              onClick={() => listen('name')}
            >
              <Icon name="mic" />
              {listening === 'name' ? t('room.assist.listeningName') : t('room.assist.sayName')}
            </button>
          ) : (
            <p className="muted">{t('room.assist.noRecognition')}</p>
          )}
          <label>
            {t('room.prejoin.nameLabel')}
            <input
              className="field"
              value={props.name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="name"
              onChange={(e) => {
                props.onName(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <button
            type="button"
            className="btn tonal assist-big"
            aria-pressed={confirmed}
            disabled={!name}
            onClick={confirmName}
          >
            <Icon name={confirmed ? 'check_circle' : 'how_to_reg'} />
            {confirmed
              ? t('room.assist.nameIs', { name })
              : t('room.assist.confirmName', { name: name || '…' })}
          </button>
          {supported && <p className="field-help">{t('room.assist.privacy')}</p>}
        </fieldset>
      ) : (
        <p>{t('room.assist.stepNameKnown', { name: props.fixedName })}</p>
      )}

      <fieldset className="plain assist-step">
        <legend>{t('room.assist.devicesLegend')}</legend>
        <button
          type="button"
          className="btn secondary assist-big"
          aria-pressed={props.audioEnabled}
          onClick={() => props.onAudio(!props.audioEnabled)}
        >
          <Icon name={props.audioEnabled ? 'mic' : 'mic_off'} />
          {toggle(props.audioEnabled, t('room.device.microphone'))}
        </button>
        <button
          type="button"
          className="btn secondary assist-big"
          aria-pressed={props.videoEnabled}
          onClick={() => props.onVideo(!props.videoEnabled)}
        >
          <Icon name={props.videoEnabled ? 'videocam' : 'videocam_off'} />
          {toggle(props.videoEnabled, t('room.device.camera'))}
        </button>
        {props.mediaError && (
          <p className="error">
            {props.mediaError === 'blocked' ? t('room.assist.permissionHelp') : t('room.prejoin.mediaFailed')}
          </p>
        )}
      </fieldset>

      <div className="assist-step">
        {props.extra}
        <button
          type="button"
          className="btn large assist-big"
          disabled={props.busy || !name || !confirmed}
          onClick={join}
        >
          <Icon name="login" />
          {props.busy ? t('room.prejoin.joining') : t('room.assist.join')}
        </button>
        {supported && (
          <button
            type="button"
            className="btn secondary assist-big"
            aria-pressed={listening === 'command'}
            disabled={props.busy || !name || !confirmed}
            onClick={() => listen('command')}
          >
            <Icon name="record_voice_over" />
            {listening === 'command' ? t('room.assist.listeningCommand') : t('room.assist.joinByVoice')}
          </button>
        )}
      </div>

      <p className="assist-status" role="status" aria-live="polite">
        {status}
      </p>
      <p className="error" role="alert">
        {props.error}
      </p>
      <button type="button" className="btn text" onClick={props.onCancel}>
        {t('room.assist.cancel')}
      </button>
    </section>
  );
}
