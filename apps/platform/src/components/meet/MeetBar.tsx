'use client';

import { useLocalParticipantPermissions, useTrackToggle } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { REACTIONS, type Reaction } from '@/lib/reactions';
import { Icon, type IconName } from '../ui/Icon';
import { useDismiss } from '../ui/useDismiss';
import { DeviceControl } from './DeviceControl';

export type PanelId =
  | 'info'
  | 'people'
  | 'chat'
  | 'activities'
  | 'polls'
  | 'breakouts'
  | 'effects'
  | 'host'
  | 'a11y'
  | 'copilot';

export interface MoreItem {
  id: string;
  icon: IconName;
  label: string;
  onSelect: () => void;
  active?: boolean;
  divided?: boolean;
}

function Clock() {
  const locale = useLocale();
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);
  return <span>{now ? now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : ''}</span>;
}

function BarButton(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
  variant?: 'wide' | 'plain' | 'narrow';
  badge?: ReactNode;
  dot?: boolean;
  expanded?: boolean;
  /** Only for controls whose label does not already say the state (the panel toggles). */
  pressed?: boolean;
}) {
  const cls = ['cbtn', props.variant ?? 'wide', props.on ? 'on' : ''].filter(Boolean).join(' ');
  return (
    <button
      className={cls}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      aria-disabled={props.disabled || undefined}
      data-tip={props.label}
      onClick={() => {
        if (!props.disabled) props.onClick();
      }}
    >
      <Icon name={props.icon} />
      {props.badge !== undefined && <span className="cbadge">{props.badge}</span>}
      {props.dot && <span className="cdot" aria-hidden />}
    </button>
  );
}

function Popover(props: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  return (
    <div ref={anchor} className="popover-anchor">
      {props.trigger(open, () => setOpen(!open))}
      {open && <div className={props.className ?? 'menu up'}>{props.children(close)}</div>}
    </div>
  );
}

const canShareScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** The single bar along the bottom of the call: meeting info, the call controls, and the panels. */
export function MeetBar(props: {
  roomName: string;
  breakout: number;
  panel: PanelId | null;
  onPanel: (panel: PanelId) => void;
  people: number;
  unreadChat: number;
  activitiesDot: boolean;
  captions: { available: boolean; on: boolean; toggle: () => void; label: string };
  handUp: boolean;
  onHand: () => void;
  onReact: (emoji: Reaction) => void;
  more: MoreItem[];
  onEffects?: () => void;
  canManage: boolean;
  lobbyWaiting: number;
  onLeave: () => void;
}) {
  const t = useT();
  const permissions = useLocalParticipantPermissions();
  const canPublish = permissions?.canPublish ?? false;
  const screen = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true, selfBrowserSurface: 'include' },
  });
  const [screenOk, setScreenOk] = useState(false);
  useEffect(() => setScreenOk(canShareScreen()), []);
  const panelButton = (
    id: PanelId,
    icon: IconName,
    label: string,
    extra?: { badge?: ReactNode; dot?: boolean },
  ) => (
    <BarButton
      icon={icon}
      label={label}
      variant="plain"
      on={props.panel === id}
      pressed={props.panel === id}
      onClick={() => props.onPanel(id)}
      {...extra}
    />
  );
  const activityOpen = props.panel === 'activities' || props.panel === 'polls';

  return (
    <footer className="meet-bar" aria-label={t('room.bar.controls')} id="meet-controls" tabIndex={-1}>
      <div className="bar-left">
        <Clock />
        <span className="bar-divider" aria-hidden />
        <span className="bar-name">
          {props.roomName}
          {props.breakout > 0 && ` · ${t('room.roomN', { n: props.breakout })}`}
        </span>
      </div>

      <div className="bar-center">
        {canPublish && <DeviceControl kind="audio" />}
        {canPublish && <DeviceControl kind="video" onEffects={props.onEffects} />}
        <BarButton
          icon={props.captions.on ? 'closed_caption' : 'closed_caption_disabled'}
          label={props.captions.label}
          on={props.captions.on}
          disabled={!props.captions.available}
          onClick={props.captions.toggle}
        />
        <Popover
          className="menu up reactions-pop"
          trigger={(open, toggle) => (
            <BarButton icon="mood" label={t('room.bar.react')} on={open} expanded={open} onClick={toggle} />
          )}
        >
          {() =>
            REACTIONS.map((emoji) => (
              <button
                key={emoji}
                className="reaction-pick"
                aria-label={t('room.bar.reactWith', { emoji })}
                onClick={() => props.onReact(emoji)}
              >
                {emoji}
              </button>
            ))
          }
        </Popover>
        {canPublish && screenOk && (
          <BarButton
            icon={screen.enabled ? 'cancel_presentation' : 'present_to_all'}
            label={screen.enabled ? t('room.bar.stopPresenting') : t('room.bar.present')}
            on={screen.enabled}
            disabled={screen.pending}
            onClick={() => void screen.toggle().catch(() => undefined)}
          />
        )}
        <BarButton
          icon="back_hand"
          label={props.handUp ? t('room.bar.lowerHand') : t('room.bar.raiseHand')}
          on={props.handUp}
          onClick={props.onHand}
        />
        <Popover
          className="menu up more-menu"
          trigger={(open, toggle) => (
            <BarButton
              icon="more_vert"
              label={t('common.moreOptions')}
              variant="narrow"
              on={open}
              expanded={open}
              onClick={toggle}
            />
          )}
        >
          {(close) =>
            props.more.map((item) => (
              <button
                key={item.id}
                className={item.divided ? 'menu-item divided' : 'menu-item'}
                role="menuitem"
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                <span className="menu-check">
                  <Icon name={item.icon} size={20} />
                </span>
                <span className="menu-text">{item.label}</span>
                {item.active && <span className="menu-on">{t('room.bar.active')}</span>}
              </button>
            ))
          }
        </Popover>
        <button
          className="cbtn leave"
          aria-label={t('room.bar.leave')}
          data-tip={t('room.bar.leave')}
          onClick={props.onLeave}
        >
          <Icon name="call_end" />
        </button>
      </div>

      <div className="bar-right">
        {panelButton('info', 'info', t('room.panels.info'))}
        {panelButton(
          'people',
          'group',
          props.lobbyWaiting > 0
            ? t('room.bar.peopleWaiting', { count: props.lobbyWaiting })
            : t('room.bar.peopleCount', { count: props.people }),
          {
            badge: props.lobbyWaiting > 0 ? `+${props.lobbyWaiting}` : props.people,
            dot: props.lobbyWaiting > 0,
          },
        )}
        {panelButton('chat', 'chat', t('room.panels.chat'), { dot: props.unreadChat > 0 })}
        <BarButton
          icon="category"
          label={t('room.panels.activities')}
          variant="plain"
          on={activityOpen}
          pressed={activityOpen}
          dot={props.activitiesDot}
          onClick={() => props.onPanel('activities')}
        />
        {props.canManage && panelButton('host', 'admin_panel_settings', t('room.panels.host'))}
      </div>
    </footer>
  );
}
