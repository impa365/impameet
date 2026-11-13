'use client';

import { useParticipants } from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { type ReactNode, useEffect, useRef } from 'react';
import { type T, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon, type IconName } from '../ui/Icon';
import { Avatar } from './Avatar';
import type { PanelId } from './MeetBar';
import { HAND_ATTRIBUTE, displayName } from './MeetTile';

const TITLES: Record<PanelId, MessageKey> = {
  info: 'room.panels.info',
  people: 'room.panels.people',
  chat: 'room.panels.chat',
  activities: 'room.panels.activities',
  polls: 'room.panels.polls',
  breakouts: 'room.panels.breakouts',
  effects: 'room.panels.effects',
  host: 'room.panels.host',
  a11y: 'room.panels.a11y',
  copilot: 'room.panels.copilot',
  studio: 'studio.panel.title',
};

const SUBVIEWS: Partial<Record<PanelId, PanelId>> = { polls: 'activities' };

/** Meet's side panel: one at a time, beside the stage, in the theme the person chose. */
export function SidePanel(props: {
  panel: PanelId | null;
  onPanel: (panel: PanelId | null) => void;
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  const t = useT();
  const { panel } = props;
  const back = panel ? SUBVIEWS[panel] : undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (panel) heading.current?.focus();
  }, [panel]);
  const title = panel ? t(TITLES[panel]) : undefined;
  return (
    <aside className={`meet-panel theme-${props.theme}`} hidden={!panel} aria-label={title}>
      <header className="meet-panel-head">
        {back && (
          <button className="icon-btn" aria-label={t('common.back')} onClick={() => props.onPanel(back)}>
            <Icon name="arrow_back" />
          </button>
        )}
        <h3 ref={heading} tabIndex={-1}>
          {title ?? ''}
        </h3>
        <button className="icon-btn" aria-label={t('common.close')} onClick={() => props.onPanel(null)}>
          <Icon name="close" />
        </button>
      </header>
      {props.children}
    </aside>
  );
}

export function InfoView(props: { roomName: string; breakout: number; copied: boolean; onCopy: () => void }) {
  const t = useT();
  const link = typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
  return (
    <div className="meet-panel-body">
      <h4 className="info-title">{props.roomName}</h4>
      {props.breakout > 0 && <p className="muted">{t('room.info.inBreakout', { n: props.breakout })}</p>}
      <p className="muted">{t('room.info.joiningInfo')}</p>
      <p className="info-link">{link}</p>
      <button className="btn text" onClick={props.onCopy}>
        <Icon name={props.copied ? 'check' : 'content_copy'} size={20} />
        {props.copied ? t('room.info.linkCopied') : t('room.info.copyJoiningInfo')}
      </button>
    </div>
  );
}

function role(p: Participant, t: T): string {
  if (p.isAgent) {
    const about = p.attributes?.['impa.about'];
    return about ? t('room.aiAssistantAbout', { about }) : t('room.aiAssistant');
  }
  if (p.attributes?.role === 'moderator') return t('room.moderator');
  return '';
}

/** Everyone in the call, as anybody sees it; moderators get the managed list instead. */
export function PeopleList() {
  const t = useT();
  const participants = useParticipants();
  const raised = participants
    .filter((p) => p.attributes?.[HAND_ATTRIBUTE])
    .sort((a, b) => Number(a.attributes[HAND_ATTRIBUTE]) - Number(b.attributes[HAND_ATTRIBUTE]));
  const nameOf = (p: Participant) => displayName(p, t('room.aiAssistant'));
  const shown = (p: Participant) => (p.isLocal ? t('room.nameYou', { name: nameOf(p) }) : nameOf(p));
  return (
    <>
      {raised.length > 0 && (
        <section className="people-section">
          <h4>{t('room.people.raisedHands', { count: raised.length })}</h4>
          {raised.map((p) => (
            <div key={p.identity} className="person-row">
              <Avatar name={nameOf(p)} agent={p.isAgent} />
              <span className="person-name">{shown(p)}</span>
              <Icon name="back_hand" size={20} className="person-hand" />
            </div>
          ))}
        </section>
      )}
      <section className="people-section">
        <h4>{t('room.people.inMeeting', { count: participants.length })}</h4>
        {participants.map((p) => (
          <div key={p.identity} className="person-row">
            <Avatar name={nameOf(p)} agent={p.isAgent} />
            <span className="person-name">
              {shown(p)}
              {role(p, t) && <small>{role(p, t)}</small>}
            </span>
            <span className="person-actions">
              <span
                className="icon-btn ghost"
                title={p.isMicrophoneEnabled ? t('room.status.micOn') : t('room.status.micOff')}
              >
                <Icon name={p.isMicrophoneEnabled ? 'mic' : 'mic_off'} size={20} />
              </span>
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

export interface Activity {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  onSelect: () => void;
  status?: string;
  dot?: boolean;
}

export function ActivitiesView({ items }: { items: Activity[] }) {
  const t = useT();
  return (
    <div className="meet-panel-body activities">
      {items.map((a) => (
        <button key={a.id} className="activity" onClick={a.onSelect}>
          <span className="activity-icon">
            <Icon name={a.icon} />
          </span>
          <span className="activity-text">
            <strong>
              {a.title}
              {a.dot && <span className="cdot inline" aria-label={t('room.activities.news')} />}
            </strong>
            <small>{a.status ?? a.description}</small>
          </span>
          <Icon name="chevron_right" size={20} />
        </button>
      ))}
    </div>
  );
}
