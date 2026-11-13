'use client';

import {
  ConnectionStateToast,
  RoomAudioRenderer,
  StartAudio,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
} from '@livekit/components-react';
import { type Participant, ParticipantEvent, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type T, useT } from '@/i18n/client';
import { resolvePanelTheme } from '@/lib/a11y';
import { REACTION_TOPIC, type Reaction, parseReaction } from '@/lib/reactions';
import { BackgroundPanel, useBackground } from '../BackgroundMenu';
import { BreakoutsView, useBreakouts } from '../Breakouts';
import { CaptionsOverlay, captionerPresent, useCaptions, useCaptionsControl } from '../Captions';
import { ModerationView } from '../ModerationPanel';
import { PollsView, usePolls } from '../Polls';
import { type CollabPolicy, RoomSettingsEditor } from '../RoomSettings';
import { WhiteboardPanel, useWhiteboard } from '../Whiteboard';
import { changeSentence } from '../BoardText';
import { CopilotView, useInsights } from './Copilot';
import { type BoardChange, ChangeDigest } from '@/lib/board-text';
import { api } from '../api';
import { Icon } from '../ui/Icon';
import {
  A11yView,
  type Cue,
  LiveRegions,
  ShortcutsDialog,
  playCue,
  useA11yPrefs,
  useSystemDark,
  useAnnouncer,
} from './a11y';
import { ChatView } from './ChatView';
import { MeetBar, type MoreItem, type PanelId } from './MeetBar';
import { type Activity, ActivitiesView, InfoView, PeopleList, SidePanel } from './MeetPanels';
import { MeetStage } from './MeetStage';
import { MeetingControls } from './MeetingControls';
import { AGENT_MUTED_ATTRIBUTE, HAND_ATTRIBUTE, displayName } from './MeetTile';
import { useRecording } from './useRecording';

const REACTION_MS = 4000;
const TOAST_MS = 5000;
const LOBBY_TOPIC = 'impa.lobby';
const POLICY_TOPIC = 'impa.policy';

export interface RoomPolicies {
  board: CollabPolicy;
  polls: CollabPolicy;
}

interface ShownReaction {
  key: number;
  emoji: Reaction;
  from: string;
}

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'range', 'color']);

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type);
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
};

const isModeratorParticipant = (p: Participant | undefined) => p?.attributes?.role === 'moderator';

/** Everything inside the call, laid out like Google Meet. Must render inside `LiveKitRoom`. */
export function MeetRoom(props: {
  slug: string;
  /** The join token: proves who we are when asking the server to change our own attributes. */
  token: string;
  roomName: string;
  role: string;
  signedIn: boolean;
  breakout: number;
  error: string;
  policies: RoomPolicies;
  onSwitchRoom: (target: number) => void;
}) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  // Stable across language switches, so room listeners are not re-registered (and "first" effects not re-run).
  const tr = useCallback<T>((key, vars) => tRef.current(key, vars), []);
  const nameOf = useCallback((p: Participant) => displayName(p, tr('room.aiAssistant')), [tr]);
  const room = useRoomContext();
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const { prefs, update: updatePrefs } = useA11yPrefs();
  const surface = resolvePanelTheme(prefs.panelTheme, useSystemDark());
  const { polite, urgent, announce } = useAnnouncer();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const cue = useCallback((kind: Cue) => {
    if (prefsRef.current.sounds) playCue(kind);
  }, []);

  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback(
    (message: string, urgent = false) => {
      setToast(message);
      announce(message, urgent);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(''), TOAST_MS);
    },
    [announce],
  );

  const [policies, setPolicies] = useState(props.policies);
  // The role lives in the participant's attributes, which the server changes when someone is
  // promoted or demoted; LiveKit's hooks do not re-render on that, so follow it here.
  const [localRole, setLocalRole] = useState(localParticipant.attributes?.role ?? props.role);
  useEffect(() => {
    const update = () => setLocalRole(room.localParticipant.attributes?.role ?? props.role);
    update();
    room.localParticipant.on(ParticipantEvent.AttributesChanged, update);
    return () => {
      room.localParticipant.off(ParticipantEvent.AttributesChanged, update);
    };
  }, [room, props.role]);
  const isModerator = localRole === 'moderator';
  const policiesRef = useRef(policies);
  policiesRef.current = policies;
  const allowedBy = useCallback(
    (kind: keyof RoomPolicies) => (identity: string) => {
      if (policiesRef.current[kind] === 'everyone') return true;
      if (identity === room.localParticipant.identity) {
        return (room.localParticipant.attributes?.role ?? props.role) === 'moderator';
      }
      return isModeratorParticipant(room.remoteParticipants.get(identity));
    },
    [room, props.role],
  );
  const applyPolicies = useCallback((change: { boardPolicy?: CollabPolicy; pollsPolicy?: CollabPolicy }) => {
    if (change.boardPolicy || change.pollsPolicy) {
      setPolicies((p) => ({ board: change.boardPolicy ?? p.board, polls: change.pollsPolicy ?? p.polls }));
    }
  }, []);
  const mayDraw = useCallback((identity: string) => allowedBy('board')(identity), [allowedBy]);
  const mayCreatePoll = useCallback((identity: string) => allowedBy('polls')(identity), [allowedBy]);
  const canDraw = policies.board === 'everyone' || isModerator;
  const canCreatePoll = policies.polls === 'everyone' || isModerator;

  const boardDigest = useRef(new ChangeDigest());
  const boardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whiteboard changes by others, read out as the person chose (never moving focus). */
  const onBoardChange = useCallback(
    (change: BoardChange) => {
      const mode = prefsRef.current.boardAnnounce;
      if (mode === 'off') return;
      boardDigest.current.add(change);
      if (boardTimer.current) return;
      const due = boardDigest.current.dueAt(mode, Date.now());
      if (due === null) return;
      boardTimer.current = setTimeout(() => {
        boardTimer.current = null;
        if (prefsRef.current.boardAnnounce === 'off') return boardDigest.current.clear();
        const said = boardDigest.current.take(Date.now()).map((c) => changeSentence(tr, c));
        if (said.length > 0) announce(`${tr('room.whiteboard.title')}: ${said.join(' ')}`);
      }, due - Date.now());
    },
    [announce, tr],
  );
  useEffect(
    () => () => {
      if (boardTimer.current) clearTimeout(boardTimer.current);
    },
    [],
  );
  const board = useWhiteboard(room, mayDraw, onBoardChange);
  const insights = useInsights(room, participants);
  const captions = useCaptions(room);
  const polls = usePolls(room, mayCreatePoll);
  const breakouts = useBreakouts(room, props.slug, props.breakout, props.onSwitchRoom);
  const background = useBackground(room);
  const recording = useRecording(room, props.slug, props.signedIn, notify);
  const captionerRunning = captionerPresent(participants);
  const transcriber = useCaptionsControl(props.slug, props.signedIn, captionerRunning, notify);

  const [panel, setPanel] = useState<PanelId | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [captionsShown, setCaptionsShown] = useState(true);
  const [handUp, setHandUp] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatCount, setChatCount] = useState(0);
  const [chatSeen, setChatSeen] = useState(0);
  const [pollsSeen, setPollsSeen] = useState(0);
  const [reactions, setReactions] = useState<ShownReaction[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [lobbyWaiting, setLobbyWaiting] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const nextKey = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);

  const pollCount = polls.state.polls.length;
  const unseenPolls = panel !== 'polls' && pollCount > pollsSeen;
  const unreadChat = panel === 'chat' ? 0 : chatCount - chatSeen;
  const silentAgents = participants
    .filter((p) => p.isAgent && p.attributes?.[AGENT_MUTED_ATTRIBUTE] === 'true')
    .map((p) => displayName(p, t('room.aiAssistant')));
  const aiSilent = silentAgents.length > 0;
  const showBreakouts = breakouts.canManage || !!breakouts.session || props.breakout > 0;
  const raisedPeople = participants
    .filter((p) => p.attributes?.[HAND_ATTRIBUTE])
    .sort((a, b) => Number(a.attributes[HAND_ATTRIBUTE]) - Number(b.attributes[HAND_ATTRIBUTE]));
  const raised = raisedPeople.map((p) => (p.isLocal ? t('room.you') : nameOf(p)));

  useEffect(() => {
    if (panel === 'chat') setChatSeen(chatCount);
    if (panel === 'polls') setPollsSeen(pollCount);
    if (panel === 'people') setLobbyWaiting(0);
  }, [panel, chatCount, pollCount]);

  useEffect(() => {
    if (props.error) notify(props.error);
  }, [props.error, notify]);

  useEffect(() => {
    if (breakouts.notice) notify(breakouts.notice);
  }, [breakouts.notice, notify]);

  // Signed-in moderators: may they open the organizer's controls? (Asked again on promotion.)
  useEffect(() => {
    if (!props.signedIn || !isModerator) {
      setCanManage(false);
      return;
    }
    api<{ canManage: boolean }>(`/api/rooms/${encodeURIComponent(props.slug)}/access`)
      .then((r) => setCanManage(r.canManage))
      .catch(() => setCanManage(false));
  }, [props.signedIn, isModerator, props.slug]);

  // Promoted or demoted during the meeting: say so, and the controls follow right away.
  const wasModerator = useRef(isModerator);
  useEffect(() => {
    if (wasModerator.current === isModerator) return;
    wasModerator.current = isModerator;
    notify(isModerator ? tr('room.moderation.nowModerator') : tr('room.moderation.noLongerModerator'));
  }, [isModerator, notify, tr]);

  // Server messages: someone knocks, or the organizer changed who may draw / create polls.
  useEffect(() => {
    const onData = (payload: Uint8Array, from?: Participant, _k?: unknown, topic?: string) => {
      if (from) return;
      if (topic === LOBBY_TOPIC && isModeratorParticipant(room.localParticipant)) {
        const message = tr('room.announce.knock');
        setLobbyWaiting((n) => n + 1);
        playCue('knock');
        notify(message, true);
        return;
      }
      if (topic === POLICY_TOPIC) {
        try {
          const next = JSON.parse(new TextDecoder().decode(payload)) as RoomPolicies;
          if (next.board && next.polls) setPolicies({ board: next.board, polls: next.polls });
        } catch {
          /* ignore malformed */
        }
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, notify, tr]);

  // Screen reader announcements and sounds for what happens in the room.
  useEffect(() => {
    const joined = (p: Participant) => {
      if (p.attributes?.['impa.mode'] === 'captions') return;
      cue('join');
      if (prefsRef.current.announceJoins) announce(tr('room.announce.joined', { name: nameOf(p) }));
    };
    const left = (p: Participant) => {
      if (p.attributes?.['impa.mode'] === 'captions') return;
      cue('leave');
      if (prefsRef.current.announceJoins) announce(tr('room.announce.left', { name: nameOf(p) }));
    };
    const muted = (pub: { source: Track.Source }, p: Participant) => {
      if (!p.isLocal) return;
      if (pub.source === Track.Source.Microphone) announce(tr('room.status.micOff'));
      if (pub.source === Track.Source.Camera) announce(tr('room.status.camOff'));
    };
    const unmuted = (pub: { source: Track.Source }, p: Participant) => {
      if (!p.isLocal) return;
      if (pub.source === Track.Source.Microphone) announce(tr('room.status.micOn'));
      if (pub.source === Track.Source.Camera) announce(tr('room.status.camOn'));
    };
    const reconnecting = () => announce(tr('room.announce.reconnecting'), true);
    const reconnected = () => announce(tr('room.announce.reconnected'), true);
    room.on(RoomEvent.ParticipantConnected, joined);
    room.on(RoomEvent.ParticipantDisconnected, left);
    room.on(RoomEvent.TrackMuted, muted);
    room.on(RoomEvent.TrackUnmuted, unmuted);
    room.on(RoomEvent.Reconnecting, reconnecting);
    room.on(RoomEvent.Reconnected, reconnected);
    return () => {
      room.off(RoomEvent.ParticipantConnected, joined);
      room.off(RoomEvent.ParticipantDisconnected, left);
      room.off(RoomEvent.TrackMuted, muted);
      room.off(RoomEvent.TrackUnmuted, unmuted);
      room.off(RoomEvent.Reconnecting, reconnecting);
      room.off(RoomEvent.Reconnected, reconnected);
    };
  }, [room, announce, cue, tr, nameOf]);

  const raisedKey = raisedPeople.map((p) => p.identity).join();
  const lastRaised = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(raisedPeople.map((p) => p.identity));
    for (const p of raisedPeople) {
      if (!lastRaised.current.has(p.identity) && !p.isLocal) {
        cue('hand');
        if (prefsRef.current.announceActivity) announce(tr('room.announce.handRaised', { name: nameOf(p) }));
      }
    }
    lastRaised.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on who has a hand up
  }, [raisedKey]);

  const firstStatus = useRef(true);
  useEffect(() => {
    if (firstStatus.current) {
      firstStatus.current = false;
      if (recording.recording) announce(tr('room.announce.recordingOngoing'), true);
      return;
    }
    announce(
      recording.recording ? tr('room.announce.recordingStarted') : tr('room.announce.recordingStopped'),
      true,
    );
  }, [recording.recording, announce, tr]);

  const firstCaption = useRef(true);
  useEffect(() => {
    if (firstCaption.current) {
      firstCaption.current = false;
      return;
    }
    announce(
      captionerRunning ? tr('room.announce.transcriptionStarted') : tr('room.announce.transcriptionStopped'),
      true,
    );
  }, [captionerRunning, announce, tr]);

  const firstSilent = useRef(true);
  useEffect(() => {
    if (firstSilent.current) {
      firstSilent.current = false;
      return;
    }
    announce(aiSilent ? tr('room.announce.aiSilent') : tr('room.announce.aiSpeaking'));
  }, [aiSilent, announce, tr]);

  const onIncomingChat = useCallback(
    (from: string, text: string) => {
      cue('message');
      if (prefsRef.current.announceChat) announce(tr('room.announce.chatMessage', { name: from, text }));
    },
    [announce, cue, tr],
  );

  const show = useCallback((emoji: Reaction, from: string) => {
    const key = nextKey.current++;
    setReactions((list) => [...list.slice(-9), { key, emoji, from }]);
    setTimeout(() => setReactions((list) => list.filter((r) => r.key !== key)), REACTION_MS);
  }, []);

  useEffect(() => {
    room.registerTextStreamHandler(REACTION_TOPIC, async (reader, sender) => {
      const emoji = parseReaction(await reader.readAll());
      const from = room.remoteParticipants.get(sender.identity);
      const name = from ? nameOf(from) : sender.identity;
      if (!emoji) return;
      show(emoji, name);
      if (prefsRef.current.announceActivity) announce(tr('room.announce.reacted', { name, emoji }));
    });
    return () => room.unregisterTextStreamHandler(REACTION_TOPIC);
  }, [room, show, announce, tr, nameOf]);

  async function react(emoji: Reaction) {
    show(emoji, t('room.you'));
    await localParticipant.sendText(emoji, { topic: REACTION_TOPIC }).catch(() => undefined);
  }

  const toggleHand = useCallback(async () => {
    const next = !handUp;
    setHandUp(next);
    announce(next ? t('room.announce.youRaised') : t('room.announce.youLowered'));
    try {
      await api(`/api/rooms/${encodeURIComponent(props.slug)}/hand`, {
        body: { token: props.token, raised: next },
      });
    } catch {
      setHandUp(!next);
      notify(t('room.announce.handFailed'));
    }
  }, [handUp, props.slug, props.token, announce, notify, t]);

  async function copyInvite() {
    await navigator.clipboard
      .writeText(`${window.location.origin}${window.location.pathname}`)
      .catch(() => undefined);
    setCopied(true);
    notify(t('room.announce.linkCopied'));
    setTimeout(() => setCopied(false), 2000);
  }

  const openPanel = useCallback((next: PanelId | null) => {
    setPanel((current) => {
      if (next && !current && document.activeElement instanceof HTMLElement) {
        returnFocus.current = document.activeElement;
      }
      if (!next && current) setTimeout(() => returnFocus.current?.focus(), 0);
      return next;
    });
  }, []);

  const togglePanel = useCallback(
    (next: PanelId) =>
      setPanel((current) => {
        if (current === next) {
          setTimeout(() => returnFocus.current?.focus(), 0);
          return null;
        }
        if (!current && document.activeElement instanceof HTMLElement)
          returnFocus.current = document.activeElement;
        return next;
      }),
    [],
  );

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  const summary = useCallback(() => {
    const people = participants.filter((p) => p.attributes?.['impa.mode'] !== 'captions');
    const parts = [
      t('room.summary.people', { count: people.length }),
      localParticipant.isMicrophoneEnabled ? t('room.summary.micOn') : t('room.summary.micOff'),
      localParticipant.isCameraEnabled ? t('room.summary.camOn') : t('room.summary.camOff'),
      recording.recording ? t('room.summary.recording') : '',
      captionerRunning ? t('room.summary.transcribing') : '',
      raised.length > 0 ? t('room.summary.hands', { names: raised.join(', ') }) : '',
    ];
    announce(parts.filter(Boolean).join('. '), true);
  }, [participants, localParticipant, recording.recording, captionerRunning, raised, announce, t]);

  const whoIsSpeaking = useCallback(() => {
    const speaking = room.activeSpeakers.map((p) => (p.isLocal ? t('room.youLower') : nameOf(p)));
    announce(
      speaking.length > 0
        ? t('room.announce.speakingNow', { names: speaking.join(', ') })
        : t('room.announce.nobodySpeaking'),
      true,
    );
  }, [room, announce, t, nameOf]);

  // Meet-style keyboard shortcuts (Ctrl + D / Ctrl + E live on the device buttons).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !shortcutsOpen && panel && !e.defaultPrevented) {
        openPanel(null);
        return;
      }
      if (isTyping(e)) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!(e.ctrlKey && e.altKey) || e.metaKey || e.shiftKey) return;
      // By physical key: with Ctrl + Alt (AltGr) some layouts change the character typed.
      const action: Record<string, () => void> = {
        KeyC: () => togglePanel('chat'),
        KeyP: () => togglePanel('people'),
        KeyA: () => togglePanel('activities'),
        KeyH: () => void toggleHand(),
        KeyS: whoIsSpeaking,
        KeyR: summary,
      };
      const run = action[e.code];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, shortcutsOpen, openPanel, togglePanel, toggleHand, whoIsSpeaking, summary]);

  const captionsControl = {
    available: captionerRunning || transcriber.canControl,
    on: captionerRunning && captionsShown,
    label: captionerRunning
      ? captionsShown
        ? t('room.captions.off')
        : t('room.captions.on')
      : transcriber.canControl
        ? t('room.captions.start')
        : t('room.captions.unavailable'),
    toggle: () => {
      if (captionerRunning) setCaptionsShown(!captionsShown);
      else if (transcriber.canControl && !transcriber.busy) {
        setCaptionsShown(true);
        void transcriber.toggleWorker();
      }
    },
  };

  const effectsAvailable = background.supported;

  const more: MoreItem[] = [
    ...(insights.any
      ? [
          {
            id: 'copilot',
            icon: 'auto_awesome' as const,
            label: t('room.panels.copilot'),
            onSelect: () => openPanel('copilot'),
          },
        ]
      : []),
    ...(effectsAvailable
      ? [
          {
            id: 'effects',
            icon: 'background_replace' as const,
            label: t('room.device.applyEffects'),
            onSelect: () => openPanel('effects'),
          },
        ]
      : []),
    ...(recording.canRecord
      ? [
          {
            id: 'record',
            icon: 'radio_button_checked' as const,
            label:
              recording.phase === 'starting'
                ? t('room.more.recordingStarting')
                : recording.phase === 'stopping'
                  ? t('room.more.recordingStopping')
                  : recording.phase === 'recording'
                    ? t('room.more.stopRecording')
                    : t('room.more.record'),
            onSelect: () => void recording.toggle(),
            active: recording.phase === 'recording' || recording.phase === 'starting',
            disabled: recording.busy,
          },
        ]
      : []),
    ...(transcriber.canControl
      ? [
          {
            id: 'transcribe',
            icon: 'subtitles' as const,
            label: captionerRunning ? t('room.more.stopTranscription') : t('room.more.transcribe'),
            onSelect: () => void transcriber.toggleWorker(),
            active: captionerRunning,
          },
        ]
      : []),
    ...(showBreakouts
      ? [
          {
            id: 'breakouts',
            icon: 'meeting_room' as const,
            label: t('room.panels.breakouts'),
            onSelect: () => openPanel('breakouts'),
          },
        ]
      : []),
    {
      id: 'invite',
      icon: 'link',
      label: t('room.more.copyLink'),
      onSelect: () => void copyInvite(),
      divided: true,
    },
    {
      id: 'a11y',
      icon: 'accessibility_new',
      label: t('room.panels.a11y'),
      onSelect: () => openPanel('a11y'),
    },
    {
      id: 'shortcuts',
      icon: 'keyboard',
      label: t('room.shortcuts.title'),
      onSelect: () => setShortcutsOpen(true),
    },
    { id: 'fullscreen', icon: 'fullscreen', label: t('room.more.fullscreen'), onSelect: toggleFullscreen },
  ];

  const activities: Activity[] = [
    {
      id: 'board',
      icon: 'draw',
      title: t('room.whiteboard.title'),
      description: canDraw ? t('room.activities.boardDraw') : t('room.activities.boardView'),
      status: boardOpen ? t('room.activities.openNow') : undefined,
      dot: board.unseen,
      onSelect: () => {
        setBoardOpen(true);
        openPanel(null);
      },
    },
    {
      id: 'polls',
      icon: 'ballot',
      title: t('room.panels.polls'),
      description: canCreatePoll ? t('room.activities.pollsCreate') : t('room.activities.pollsVote'),
      status: pollCount > 0 ? t('room.activities.pollCount', { count: pollCount }) : undefined,
      dot: unseenPolls,
      onSelect: () => openPanel('polls'),
    },
  ];

  return (
    <div className={prefs.largeCaptions ? 'meet theme-dark big-captions' : 'meet theme-dark'}>
      <a className="skip-link" href="#meet-controls">
        {t('room.stage.skipToControls')}
      </a>
      <LiveRegions polite={polite} urgent={urgent} />
      <div className="meet-body">
        <main className="meet-main" aria-label={t('room.stage.participants')}>
          <MeetStage />
          {boardOpen && (
            <div className="meet-board">
              <WhiteboardPanel board={board} readOnly={!canDraw} onClose={() => setBoardOpen(false)} />
            </div>
          )}
          <div className="meet-chips">
            {recording.recording && recording.phase !== 'idle' ? (
              <span className="chip-rec">
                <span className="rec-dot" aria-hidden /> {t('room.stage.recording')}
              </span>
            ) : recording.recording ? (
              <span className="chip-soft">{t('room.stage.recordingFinishing')}</span>
            ) : (
              recording.phase === 'starting' && (
                <span className="chip-soft" role="status">
                  <span className="rec-dot" aria-hidden /> {t('room.stage.recordingStarting')}
                </span>
              )
            )}
            {captionerRunning && <span className="chip-soft">{t('room.stage.transcribing')}</span>}
            {aiSilent && (
              <span className="chip-soft" title={t('room.stage.aiSilentTip')}>
                <Icon name="smart_toy" size={16} />{' '}
                {t('room.status.aiSilentNamed', { name: silentAgents.join(', ') })}
              </span>
            )}
            {raised.length > 0 && (
              <span className="chip-soft">
                <Icon name="back_hand" size={16} /> {raised.join(', ')}
              </span>
            )}
          </div>
          {captionsShown && <CaptionsOverlay captions={captions} />}
          <div className="reactions" aria-hidden>
            {reactions.map((r) => (
              <span key={r.key} className="reaction">
                <span className="reaction-emoji">{r.emoji}</span>
                <small>{r.from}</small>
              </span>
            ))}
          </div>
        </main>

        <SidePanel panel={panel} onPanel={openPanel} theme={surface}>
          <ChatView visible={panel === 'chat'} onCount={setChatCount} onIncoming={onIncomingChat} />
          {panel === 'info' && (
            <InfoView
              roomName={props.roomName}
              breakout={props.breakout}
              copied={copied}
              onCopy={() => void copyInvite()}
            />
          )}
          {panel === 'people' && (
            <div className="meet-panel-body">
              <button className="btn tonal" onClick={() => void copyInvite()}>
                <Icon name="link" size={20} />
                {t('room.stage.copyInviteLink')}
              </button>
              {isModerator ? (
                <ModerationView slug={props.slug} token={props.token} fallback={<PeopleList />} />
              ) : (
                <PeopleList />
              )}
            </div>
          )}
          {panel === 'activities' && <ActivitiesView items={activities} />}
          {panel === 'polls' && (
            <div className="meet-panel-body">
              <PollsView
                polls={polls}
                myName={localParticipant.name || t('room.participant')}
                canCreate={canCreatePoll}
              />
            </div>
          )}
          {panel === 'breakouts' && (
            <div className="meet-panel-body">
              <BreakoutsView
                slug={props.slug}
                current={props.breakout}
                breakouts={breakouts}
                participants={participants}
                onSwitch={props.onSwitchRoom}
              />
            </div>
          )}
          {panel === 'effects' && (
            <div className="meet-panel-body">
              <BackgroundPanel background={background} />
            </div>
          )}
          {panel === 'host' && (canManage || isModerator) && (
            <div className="meet-panel-body">
              {canManage ? (
                <RoomSettingsEditor slug={props.slug} showAgent onChanged={applyPolicies} />
              ) : (
                <MeetingControls slug={props.slug} token={props.token} onChanged={applyPolicies} />
              )}
            </div>
          )}
          {panel === 'copilot' && <CopilotView insights={insights} />}
          {panel === 'a11y' && (
            <A11yView prefs={prefs} onChange={updatePrefs} onShortcuts={() => setShortcutsOpen(true)} />
          )}
        </SidePanel>
      </div>

      <MeetBar
        roomName={props.roomName}
        breakout={props.breakout}
        panel={panel}
        onPanel={togglePanel}
        people={participants.length}
        unreadChat={unreadChat}
        activitiesDot={board.unseen || unseenPolls}
        captions={captionsControl}
        handUp={handUp}
        onHand={() => void toggleHand()}
        onReact={(emoji) => void react(emoji)}
        more={more}
        onEffects={effectsAvailable ? () => openPanel('effects') : undefined}
        canManage={canManage || isModerator}
        lobbyWaiting={lobbyWaiting}
        onLeave={() => void room.disconnect()}
      />

      {toast && (
        <div className="meet-toast" aria-hidden>
          {toast}
        </div>
      )}
      {shortcutsOpen && <ShortcutsDialog theme={surface} onClose={() => setShortcutsOpen(false)} />}
      <StartAudio label={t('room.stage.startAudio')} className="meet-start-audio" />
      <ConnectionStateToast />
      <RoomAudioRenderer />
    </div>
  );
}
