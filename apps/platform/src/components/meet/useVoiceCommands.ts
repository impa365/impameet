'use client';

import { useRoomContext } from '@livekit/components-react';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { SPEECH_LANG } from '@/lib/assisted-join';
import { type MediaDevice, parseVoiceCommand } from '@/lib/voice-commands';
import { type Recognition, recognitionCtor, say } from './speech';

export type VoiceStatus = 'off' | 'listening' | 'blocked' | 'unsupported';

/** The same command twice this fast is one command heard twice. */
const REPEAT_MS = 2000;
const MAX_RESTART_MS = 5000;

/**
 * The local assistant during the call: when the person turned it on, the browser listens for its
 * name and simple commands ("Star, desliga meu microfone", "Star, minha câmera está ligada?").
 * Plain rules, no model; every answer says the real state after acting, or why it could not.
 */
export function useVoiceCommands(enabled: boolean, wakeWord: string, announce: (message: string) => void) {
  const t = useT();
  const locale = useLocale();
  const lang = SPEECH_LANG[locale];
  const room = useRoomContext();
  const [status, setStatus] = useState<VoiceStatus>('off');
  const live = useRef({ wakeWord, announce, t, last: { key: '', at: 0 }, lastReply: '' });
  live.current.wakeWord = wakeWord;
  live.current.announce = announce;
  live.current.t = t;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setStatus('unsupported');
      return;
    }
    let stopped = false;
    let current: Recognition | null = null;
    let restarts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reply = (text: string) => {
      live.current.lastReply = text;
      live.current.announce(text);
      say(text, lang);
    };

    const isOn = (device: MediaDevice) =>
      device === 'microphone'
        ? room.localParticipant.isMicrophoneEnabled
        : room.localParticipant.isCameraEnabled;
    const line = (device: MediaDevice) =>
      live.current.t(device === 'microphone' ? 'voice.microphoneIs' : 'voice.cameraIs', {
        state: isOn(device) ? live.current.t('voice.on') : live.current.t('voice.off'),
      });

    const run = async (transcript: string) => {
      const tr = live.current.t;
      const cmd = parseVoiceCommand(transcript, live.current.wakeWord);
      if (!cmd) return;
      const key = JSON.stringify(cmd);
      if (key === live.current.last.key && Date.now() - live.current.last.at < REPEAT_MS) return;
      live.current.last = { key, at: Date.now() };
      if (cmd.kind === 'status') return reply(cmd.devices.map(line).join(' '));
      if (cmd.kind === 'repeat') return reply(live.current.lastReply || tr('voice.nothingToRepeat'));
      if (cmd.kind === 'join') return reply(tr('voice.alreadyIn'));
      if (cmd.kind === 'unknown') return reply(tr('voice.commandUnknown', { name: live.current.wakeWord }));
      if (room.localParticipant.permissions?.canPublish === false) return reply(tr('voice.cannotPublish'));
      const failed: MediaDevice[] = [];
      for (const device of cmd.devices) {
        try {
          if (device === 'microphone') await room.localParticipant.setMicrophoneEnabled(cmd.on);
          else await room.localParticipant.setCameraEnabled(cmd.on);
        } catch {
          failed.push(device);
        }
      }
      const said = cmd.devices.map(line);
      if (failed.length > 0) said.push(tr('voice.deviceBlocked'));
      reply(said.join(' '));
    };

    const start = () => {
      if (stopped) return;
      const r = new Ctor();
      r.lang = lang;
      r.continuous = true;
      r.interimResults = false;
      r.maxAlternatives = 1;
      r.onresult = (e) => {
        restarts = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result?.isFinal) void run(result[0]?.transcript ?? '');
        }
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          stopped = true;
          setStatus('blocked');
          reply(live.current.t('voice.listeningBlocked'));
        }
      };
      // Browsers end a long listening session on their own: start again, a little slower each time.
      r.onend = () => {
        if (stopped) return;
        restarts += 1;
        timer = setTimeout(start, Math.min(MAX_RESTART_MS, 300 * restarts));
      };
      current = r;
      try {
        r.start();
        setStatus('listening');
      } catch {
        timer = setTimeout(start, MAX_RESTART_MS);
      }
    };

    start();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.abort();
    };
  }, [enabled, lang, room]);

  return status;
}
