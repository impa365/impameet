'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import {
  A11Y_STORAGE_KEY,
  type A11yPrefs,
  DEFAULT_A11Y,
  PANEL_THEMES,
  type PanelTheme,
  SHORTCUTS,
  parseA11yPrefs,
} from '@/lib/a11y';
import { BOARD_ANNOUNCE, type BoardAnnounce } from '@/lib/board-text';
import { LanguageSwitcher } from '../LanguageSwitcher';

export { DEFAULT_A11Y, SHORTCUTS, parseA11yPrefs, type A11yPrefs } from '@/lib/a11y';

/** The system's light/dark preference, kept up to date; null until known (or unsupported). */
export function useSystemDark(): boolean | null {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setDark(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return dark;
}

const BOARD_LABEL: Record<BoardAnnounce, MessageKey> = {
  all: 'room.a11y.boardAll',
  summary: 'room.a11y.boardSummary',
  off: 'room.a11y.boardOff',
};

const THEME_LABEL: Record<PanelTheme, MessageKey> = {
  system: 'room.a11y.themeSystem',
  light: 'room.a11y.themeLight',
  dark: 'room.a11y.themeDark',
};

export function useA11yPrefs() {
  const [prefs, setPrefs] = useState<A11yPrefs>(DEFAULT_A11Y);
  useEffect(() => setPrefs(parseA11yPrefs(window.localStorage.getItem(A11Y_STORAGE_KEY))), []);
  const update = useCallback((change: Partial<A11yPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...change };
      window.localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { prefs, update };
}

/**
 * Two live regions (polite and urgent). Repeating the same sentence still gets read, because
 * the text alternates a trailing no-break space.
 */
export function useAnnouncer() {
  const [polite, setPolite] = useState('');
  const [urgent, setUrgent] = useState('');
  const flip = useRef(false);
  const announce = useCallback((text: string, isUrgent = false) => {
    flip.current = !flip.current;
    const value = flip.current ? text : `${text}\u00a0`;
    (isUrgent ? setUrgent : setPolite)(value);
  }, []);
  return { polite, urgent, announce };
}

export function LiveRegions({ polite, urgent }: { polite: string; urgent: string }) {
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {urgent}
      </div>
    </>
  );
}

export type Cue = 'join' | 'leave' | 'knock' | 'message' | 'hand';

const CUES: Record<Cue, [number, number][]> = {
  join: [
    [660, 0.08],
    [880, 0.1],
  ],
  leave: [
    [880, 0.08],
    [660, 0.1],
  ],
  knock: [
    [740, 0.09],
    [740, 0.09],
    [988, 0.14],
  ],
  message: [[1046, 0.07]],
  hand: [
    [784, 0.07],
    [1046, 0.09],
  ],
};

let audio: AudioContext | null = null;

/** Short synthesized tones: no files to download, and nothing runs until the first cue. */
export function playCue(cue: Cue): void {
  if (typeof window === 'undefined') return;
  try {
    audio ??= new AudioContext();
    let at = audio.currentTime;
    for (const [freq, length] of CUES[cue]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + length + 0.02);
      at += length + 0.03;
    }
  } catch {
    /* no audio output available */
  }
}

export function ShortcutsDialog({ onClose, theme }: { onClose: () => void; theme: 'light' | 'dark' }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className={`dialog theme-${theme}`} aria-labelledby="shortcuts-title" onClose={onClose}>
      <header className="dialog-head">
        <h2 id="shortcuts-title">{t('room.shortcuts.title')}</h2>
        <button className="btn text" onClick={onClose} autoFocus>
          {t('common.close')}
        </button>
      </header>
      <table className="grid shortcuts">
        <thead>
          <tr>
            <th scope="col">{t('room.shortcuts.keys')}</th>
            <th scope="col">{t('room.shortcuts.action')}</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map(([keys, action]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{t(action)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  );
}

export function A11yView(props: {
  prefs: A11yPrefs;
  onChange: (change: Partial<A11yPrefs>) => void;
  onShortcuts: () => void;
}) {
  const { prefs, onChange } = props;
  const t = useT();
  const row = (
    key: Exclude<keyof A11yPrefs, 'panelTheme' | 'boardAnnounce'>,
    label: MessageKey,
    help: MessageKey,
  ) => (
    <label className="switch a11y-row" key={key}>
      <input type="checkbox" checked={prefs[key]} onChange={(e) => onChange({ [key]: e.target.checked })} />
      <span>
        {t(label)}
        <small>{t(help)}</small>
      </span>
    </label>
  );
  return (
    <div className="meet-panel-body">
      <div
        role="group"
        aria-labelledby="a11y-language"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <span>
          <strong id="a11y-language">{t('common.language')}</strong>
          <small style={{ display: 'block' }}>{t('room.a11y.languageHelp')}</small>
        </span>
        <LanguageSwitcher />
      </div>
      <fieldset className="group theme-choice">
        <legend>{t('room.a11y.theme')}</legend>
        <small className="muted">{t('room.a11y.themeHelp')}</small>
        {PANEL_THEMES.map((value) => (
          <label key={value} className="radio-row">
            <input
              type="radio"
              name="panel-theme"
              value={value}
              checked={prefs.panelTheme === value}
              onChange={() => onChange({ panelTheme: value })}
            />
            <span>{t(THEME_LABEL[value])}</span>
          </label>
        ))}
      </fieldset>
      <p className="muted">{t('room.a11y.intro')}</p>
      {row('announceJoins', 'room.a11y.joins', 'room.a11y.joinsHelp')}
      {row('announceChat', 'room.a11y.chat', 'room.a11y.chatHelp')}
      {row('announceActivity', 'room.a11y.activity', 'room.a11y.activityHelp')}
      {row('sounds', 'room.a11y.sounds', 'room.a11y.soundsHelp')}
      {row('largeCaptions', 'room.a11y.largeCaptions', 'room.a11y.largeCaptionsHelp')}
      <fieldset className="group theme-choice">
        <legend>{t('room.a11y.board')}</legend>
        <small className="muted">{t('room.a11y.boardHelp')}</small>
        {BOARD_ANNOUNCE.map((value) => (
          <label key={value} className="radio-row">
            <input
              type="radio"
              name="board-announce"
              value={value}
              checked={prefs.boardAnnounce === value}
              onChange={() => onChange({ boardAnnounce: value })}
            />
            <span>{t(BOARD_LABEL[value])}</span>
          </label>
        ))}
      </fieldset>
      <p className="muted">{t('room.a11y.always')}</p>
      <button className="btn tonal" onClick={props.onShortcuts}>
        {t('room.a11y.viewShortcuts')}
      </button>
    </div>
  );
}
