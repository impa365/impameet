'use client';

import { type LocalUserChoices, LiveKitRoom } from '@livekit/components-react';
import { type RoomOptions, VideoPresets } from 'livekit-client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { SPEECH_LANG } from '@/lib/assisted-join';
import { ApiError, api } from './api';
import { MeetPrejoin } from './meet/MeetPrejoin';
import { MeetRoom, type RoomPolicies } from './meet/MeetRoom';

interface LobbyTicket {
  id: string;
  secret: string;
}

interface JoinResponse {
  serverUrl: string;
  token: string;
  role: 'moderator' | 'participant' | 'guest';
  roomName: string;
  policies: RoomPolicies;
}

export function MeetingRoom(props: {
  slug: string;
  roomName: string;
  productName: string;
  userName: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const tRef = useRef(t);
  tRef.current = t;
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [session, setSession] = useState<JoinResponse | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [left, setLeft] = useState(false);
  const [ticket, setTicket] = useState<LobbyTicket | null>(null);
  const [breakout, setBreakout] = useState(0);
  const [joining, setJoining] = useState(false);
  const switching = useRef(false);
  /** Came in through the guided entry: the waiting room also speaks what happens. */
  const assistedRef = useRef(false);
  const [lobbyState, setLobbyState] = useState<'sent' | 'waiting'>('sent');

  const say = (text: string) => {
    if (!assistedRef.current || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = SPEECH_LANG[locale];
    window.speechSynthesis.speak(utterance);
  };
  const sayRef = useRef(say);
  sayRef.current = say;

  async function switchRoom(target: number) {
    if (!session) return;
    switching.current = true;
    try {
      const next = await api<JoinResponse>(`/api/rooms/${encodeURIComponent(props.slug)}/breakouts/switch`, {
        body: { token: session.token, target },
      });
      setSession(next);
      setBreakout(target);
    } catch (err) {
      switching.current = false;
      setError(err instanceof ApiError ? err.message : t('room.meeting.switchFailed'));
    }
  }

  async function join(values: LocalUserChoices, assisted = false) {
    assistedRef.current = assisted;
    setChoices(values);
    setError('');
    setJoining(true);
    try {
      const res = await api<JoinResponse | { lobby: LobbyTicket }>(
        `/api/rooms/${encodeURIComponent(props.slug)}/join`,
        { body: { displayName: props.userName ?? values.username, password: password || undefined } },
      );
      if ('lobby' in res) {
        setLobbyState('sent');
        setTicket(res.lobby);
        say(`${t('room.meeting.lobbySent')} ${t('room.meeting.askingHelp', { room: props.roomName })}`);
      } else {
        say(t('room.meeting.entering'));
        setSession(res);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'room_password') setNeedsPassword(true);
      const message = err instanceof ApiError ? err.message : t('room.meeting.joinFailed');
      setError(message);
      say(message);
    } finally {
      setJoining(false);
    }
  }

  useEffect(() => {
    if (!ticket) return;
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        try {
          const res = await api<{ status: string } & Partial<JoinResponse>>(
            `/api/rooms/${encodeURIComponent(props.slug)}/lobby/status`,
            { body: ticket },
          );
          if (res.status === 'approved' && res.token && res.serverUrl) {
            sayRef.current(tRef.current('room.meeting.lobbyApproved'));
            setSession(res as JoinResponse);
            setTicket(null);
            return;
          }
          if (res.status === 'denied') {
            setTicket(null);
            setError(tRef.current('room.meeting.denied'));
            sayRef.current(tRef.current('room.meeting.denied'));
            return;
          }
          setLobbyState('waiting');
        } catch {
          /* transient network error: keep waiting */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [ticket, props.slug]);

  const options = useMemo<RoomOptions>(
    () => ({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        deviceId: choices?.videoDeviceId || undefined,
        resolution: VideoPresets.h720.resolution,
      },
      audioCaptureDefaults: { deviceId: choices?.audioDeviceId || undefined },
      publishDefaults: { simulcast: true, videoSimulcastLayers: [VideoPresets.h360, VideoPresets.h180] },
    }),
    [choices],
  );

  if (left) {
    return (
      <main className="call-screen theme-dark">
        <h1>{t('room.meeting.left')}</h1>
        <p className="muted">{t('room.meeting.thanks', { product: props.productName })}</p>
        <div className="row">
          <button className="btn tonal" onClick={() => window.location.reload()}>
            {t('room.meeting.rejoin')}
          </button>
          <Link className="btn" href="/">
            {t('room.meeting.home')}
          </Link>
        </div>
      </main>
    );
  }

  if (ticket) {
    return (
      <main className="call-screen theme-dark" aria-labelledby="lobby-title">
        <span className="spinner" aria-hidden />
        <h1 id="lobby-title">{t('room.meeting.asking')}</h1>
        <p className="muted">{t('room.meeting.askingHelp', { room: props.roomName })}</p>
        <p role="status" aria-live="polite">
          {lobbyState === 'sent' ? t('room.meeting.lobbySent') : t('room.meeting.lobbyWaiting')}
        </p>
        <button
          className="btn tonal"
          onClick={() => {
            setTicket(null);
            say(t('room.meeting.lobbyCancelled'));
          }}
        >
          {t('common.cancel')}
        </button>
      </main>
    );
  }

  if (!session || !choices) {
    return (
      <MeetPrejoin
        roomName={props.roomName}
        userName={props.userName}
        busy={joining}
        error={error}
        onJoin={join}
        extra={
          needsPassword && (
            <input
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('room.meeting.password')}
              aria-label={t('room.meeting.password')}
              autoFocus
            />
          )
        }
      />
    );
  }

  return (
    <LiveKitRoom
      key={session.token}
      className="meeting"
      serverUrl={session.serverUrl}
      token={session.token}
      connect
      audio={choices.audioEnabled}
      video={choices.videoEnabled}
      options={options}
      onConnected={() => {
        switching.current = false;
        say(t('room.meeting.inside', { room: session.roomName }));
        assistedRef.current = false;
      }}
      onDisconnected={() => {
        if (!switching.current) setLeft(true);
      }}
      data-lk-theme="default"
    >
      <MeetRoom
        slug={props.slug}
        token={session.token}
        roomName={session.roomName}
        role={session.role}
        signedIn={props.userName !== null}
        breakout={breakout}
        error={error}
        policies={session.policies ?? { board: 'everyone', polls: 'everyone' }}
        onSwitchRoom={switchRoom}
      />
    </LiveKitRoom>
  );
}
