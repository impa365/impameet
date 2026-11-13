'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { MAX_NAME_LENGTH, SPEECH_LANG, spokenName } from '@/lib/assisted-join';
import {
  type MediaDevice,
  normalizeSpeech,
  parseDeviceAnswer,
  parseVoiceCommand,
  parseYesNo,
} from '@/lib/voice-commands';
import { Icon } from '../ui/Icon';
import { type Recognition, hush, recognitionCtor, say } from './speech';

type Step = 'name' | 'confirm' | 'microphone' | 'camera' | 'final';

/** After this many answers in a row it did not understand, the conversation pauses. */
const MAX_MISSES = 3;
/** With the voice off, a screen reader reads the question first: wait before listening. */
const READER_PAUSE_MS = 1800;
const NAME_WORDS = /\s(?:nome|name|nombre)\s/;

/**
 * A guided way in for people who cannot type or find small controls, as a conversation: it asks
 * for the name, repeats it for a yes or no, says the real state of the microphone and camera and
 * asks about each, then asks before joining. Every step also works with the buttons, the
 * keyboard or touch; the conversation can be paused at any time. Nothing here records audio:
 * recognition runs in the browser (which may use its vendor's service, as the page says).
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
  /** The local assistant's name ("Star, desliga meu microfone"). */
  wakeWord: string;
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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [supported] = useState(() => recognitionCtor() !== null);
  const firstStep: Step = props.fixedName === null ? 'name' : 'microphone';
  const [step, setStep] = useState<Step>(firstStep);
  const [talking, setTalking] = useState(supported);
  const [listening, setListening] = useState(false);
  const [confirmed, setConfirmed] = useState(props.fixedName !== null);
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState('');
  // Screen reader users already hear the status line: they can turn the second voice off.
  const [aloud, setAloud] = useState(true);
  const name = (props.fixedName ?? props.name).trim();

  // Everything the speech callbacks read, always current (they outlive renders).
  const live = useRef({ step, talking, aloud, confirmed, name, misses: 0 });
  live.current.step = step;
  live.current.talking = talking;
  live.current.aloud = aloud;
  /** What the devices will be: set at once when changed by voice, before the page re-renders. */
  const want = useRef({ audio: props.audioEnabled, video: props.videoEnabled });
  useEffect(() => {
    want.current = { audio: props.audioEnabled, video: props.videoEnabled };
  }, [props.audioEnabled, props.videoEnabled]);
  const propsRef = useRef(props);
  propsRef.current = props;

  const state = (on: boolean) =>
    props.mediaError === 'blocked' ? t('voice.blocked') : on ? t('voice.on') : t('voice.off');

  function questionFor(s: Step): string {
    const w = want.current;
    switch (s) {
      case 'name':
        return t('voice.askName');
      case 'confirm':
        return t('voice.askConfirmName', { name: live.current.name });
      case 'microphone':
        return t('voice.askMicrophone', { state: state(w.audio) });
      case 'camera':
        return t('voice.askCamera', { state: state(w.video) });
      default:
        return t('voice.askJoin', { microphone: state(w.audio), camera: state(w.video) });
    }
  }

  function clearTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  function stopListening() {
    clearTimer();
    recognition.current?.abort();
    recognition.current = null;
    setListening(false);
  }

  /** Says something; then, if the conversation is on, listens for the answer. */
  function speakThenListen(text: string) {
    setStatus(text);
    stopListening();
    const next = () => {
      if (!live.current.talking) return;
      clearTimer();
      timer.current = setTimeout(listen, 250);
    };
    if (live.current.aloud) say(text, lang, next);
    else {
      hush();
      clearTimer();
      if (live.current.talking) timer.current = setTimeout(listen, READER_PAUSE_MS);
    }
  }

  function ask(s: Step, before = '') {
    live.current.step = s;
    setStep(s);
    const q = questionFor(s);
    setQuestion(q);
    speakThenListen(`${before}${q}`);
  }

  function pause(message: string) {
    live.current.talking = false;
    setTalking(false);
    stopListening();
    setStatus(message);
    if (live.current.aloud) say(message, lang);
  }

  function miss(message: string) {
    live.current.misses += 1;
    if (live.current.misses >= MAX_MISSES) return pause(t('voice.paused'));
    ask(live.current.step, `${message} `);
  }

  function listen() {
    const Ctor = recognitionCtor();
    if (!Ctor || !live.current.talking) return;
    recognition.current?.abort();
    const r = new Ctor();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    let heard = false;
    r.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? '';
      if (!said.trim() || heard) return;
      heard = true;
      handle(said);
    };
    r.onerror = (e) => {
      if (e.error === 'aborted') return;
      heard = true;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') pause(t('room.assist.micBlocked'));
      else if (e.error === 'no-speech') miss(t('voice.noSpeech'));
      else pause(t('voice.recognitionFailed'));
    };
    r.onend = () => {
      if (recognition.current === r) setListening(false);
    };
    recognition.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
    }
  }

  function setDevice(device: MediaDevice, on: boolean) {
    if (device === 'microphone') {
      want.current.audio = on;
      propsRef.current.onAudio(on);
    } else {
      want.current.video = on;
      propsRef.current.onVideo(on);
    }
  }

  function deviceLine(device: MediaDevice): string {
    const on = device === 'microphone' ? want.current.audio : want.current.video;
    return t(device === 'microphone' ? 'voice.microphoneIs' : 'voice.cameraIs', { state: state(on) });
  }

  /** "Star, …": works at any step and then the step's question comes back. */
  function command(said: string): boolean {
    const cmd = parseVoiceCommand(said, propsRef.current.wakeWord);
    if (!cmd) return false;
    live.current.misses = 0;
    const current = live.current.step;
    if (cmd.kind === 'set') {
      for (const d of cmd.devices) setDevice(d, cmd.on);
      ask(current, `${cmd.devices.map(deviceLine).join(' ')} `);
    } else if (cmd.kind === 'status') {
      ask(current, `${cmd.devices.map(deviceLine).join(' ')} `);
    } else if (cmd.kind === 'join') {
      // Never straight in: the final question still asks.
      if (live.current.confirmed && live.current.name) ask('final');
      else ask(current, `${t('voice.confirmNameFirst')} `);
    } else if (cmd.kind === 'repeat') {
      ask(current);
    } else {
      ask(current, `${t('voice.commandUnknown', { name: propsRef.current.wakeWord })} `);
    }
    return true;
  }

  function handle(said: string) {
    if (command(said)) return;
    const current = live.current.step;
    if (current === 'name') {
      const heard = spokenName(said);
      if (!heard) return miss(t('voice.notUnderstood'));
      live.current.misses = 0;
      live.current.name = heard;
      live.current.confirmed = false;
      setConfirmed(false);
      propsRef.current.onName(heard);
      return ask('confirm');
    }
    if (current === 'confirm' || current === 'final') {
      const answer = parseYesNo(said);
      if (
        current === 'final' &&
        answer !== 'yes' &&
        NAME_WORDS.test(` ${normalizeSpeech(said)} `) &&
        !props.fixedName
      )
        return ask('name');
      if (answer === 'repeat') return ask(current);
      if (answer === null) return miss(t('voice.sayYesOrNo'));
      live.current.misses = 0;
      if (current === 'confirm') {
        if (answer === 'no') return ask('name', `${t('voice.letsTryAgain')} `);
        live.current.confirmed = true;
        setConfirmed(true);
        return ask('microphone', `${t('room.assist.nameConfirmed', { name: live.current.name })} `);
      }
      if (answer === 'no') return ask('microphone', `${t('voice.review')} `);
      return join();
    }
    const device: MediaDevice = current === 'microphone' ? 'microphone' : 'camera';
    const on = parseDeviceAnswer(said, device === 'microphone' ? want.current.audio : want.current.video);
    if (on === null) return miss(t('voice.sayOnOffKeep'));
    live.current.misses = 0;
    setDevice(device, on);
    ask(device === 'microphone' ? 'camera' : 'final', `${deviceLine(device)} `);
  }

  function join() {
    const n = live.current.name;
    if (!n) return ask('name', `${t('room.assist.nameMissing')} `);
    if (!live.current.confirmed) return ask('confirm', `${t('room.assist.confirmFirst', { name: n })} `);
    live.current.talking = false;
    setTalking(false);
    stopListening();
    setStatus(t('room.assist.joining'));
    if (live.current.aloud) say(t('room.assist.joining'), lang);
    propsRef.current.onJoin();
  }

  useEffect(() => {
    const conversation = live.current;
    heading.current?.focus();
    const intro = `${t('room.assist.intro', { room: props.roomName })} `;
    if (supported) {
      const known =
        props.fixedName === null ? '' : `${t('room.assist.stepNameKnown', { name: props.fixedName })} `;
      ask(firstStep, `${intro}${t('voice.howItWorks', { name: props.wakeWord })} ${known}`);
    } else {
      const text = `${intro}${props.fixedName === null ? t('room.assist.stepNameType') : t('room.assist.stepNameKnown', { name: props.fixedName })} ${t('room.assist.stepDevices')} ${t('room.assist.stepJoin')}`;
      setStatus(text);
      say(text, lang);
    }
    return () => {
      conversation.talking = false;
      clearTimer();
      recognition.current?.abort();
      hush();
    };
    // Only when the assisted entry opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A name typed by hand is a new name: it needs its own confirmation.
  useEffect(() => {
    if (name !== live.current.name) {
      live.current.name = name;
      if (props.fixedName === null) {
        live.current.confirmed = false;
        setConfirmed(false);
      }
    }
  }, [name, props.fixedName]);

  function confirmByHand() {
    if (!name) return speakThenListen(t('room.assist.nameMissing'));
    live.current.confirmed = true;
    setConfirmed(true);
    if (step === 'name' || step === 'confirm')
      ask('microphone', `${t('room.assist.nameConfirmed', { name })} `);
    else setStatus(t('room.assist.nameConfirmed', { name }));
  }

  function resume(from: Step = live.current.step) {
    live.current.talking = true;
    live.current.misses = 0;
    setTalking(true);
    ask(from);
  }

  const toggle = (on: boolean, label: string) =>
    `${label}: ${on ? t('room.assist.on') : t('room.assist.off')}`;

  return (
    <section className="assist" aria-labelledby="assist-title">
      <h2 id="assist-title" ref={heading} tabIndex={-1}>
        {t('room.assist.title')}
      </h2>
      <p>{t('room.assist.intro', { room: props.roomName })}</p>
      {supported && question && (
        <p className="assist-question" aria-hidden>
          {listening && <span className="rec-dot" />} {question}
        </p>
      )}
      <div className="assist-row">
        {supported && (
          <button
            type="button"
            className="btn assist-big"
            onClick={() => (talking ? pause(t('voice.pausedByYou')) : resume())}
          >
            <Icon name={talking ? 'stop_circle' : 'record_voice_over'} />
            {talking ? t('voice.pause') : t('voice.resume')}
          </button>
        )}
        <button
          type="button"
          className="btn secondary assist-big"
          onClick={() => (supported && talking ? ask(step) : setStatus(question || status))}
        >
          <Icon name="volume_up" />
          {t('voice.repeatQuestion')}
        </button>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={aloud}
          onChange={(e) => {
            setAloud(e.target.checked);
            live.current.aloud = e.target.checked;
            if (!e.target.checked) hush();
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
          {!supported && <p className="muted">{t('room.assist.noRecognition')}</p>}
          <label>
            {t('voice.typeName')}
            <input
              className="field"
              value={props.name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="name"
              onChange={(e) => props.onName(e.target.value)}
            />
          </label>
          <div className="assist-row">
            <button
              type="button"
              className="btn tonal assist-big"
              aria-pressed={confirmed}
              disabled={!name}
              onClick={confirmByHand}
            >
              <Icon name={confirmed ? 'check_circle' : 'how_to_reg'} />
              {confirmed
                ? t('room.assist.nameIs', { name })
                : t('room.assist.confirmName', { name: name || '…' })}
            </button>
            {supported && (
              <button type="button" className="btn secondary assist-big" onClick={() => resume('name')}>
                <Icon name="mic" />
                {t('voice.sayNameAgain')}
              </button>
            )}
          </div>
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
        {supported && <p className="field-help">{t('voice.commandsHint', { name: props.wakeWord })}</p>}
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
