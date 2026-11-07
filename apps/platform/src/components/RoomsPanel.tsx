'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { type AgentChoice, MAX_ROOM_AGENTS, type RoomAccess, RoomSettingsEditor } from './RoomSettings';
import { CreateRoomWizard } from './CreateRoomWizard';
import { ApiError, api } from './api';
import { EmptyState } from './ui/EmptyState';
import { Icon } from './ui/Icon';
import { useDismiss } from './ui/useDismiss';

export interface RoomSummary {
  slug: string;
  name: string;
  hasPassword: boolean;
  allowGuests: boolean;
  access: RoomAccess;
  agentIds: string[];
}

export type AgentOption = AgentChoice;

const ACCESS_CHIP: Record<RoomAccess, MessageKey> = {
  open: 'dashboard.rooms.chipAccess.open',
  trusted: 'dashboard.rooms.chipAccess.trusted',
  restricted: 'dashboard.rooms.chipAccess.restricted',
};

export function RoomsPanel({
  initialRooms,
  agents,
  startCreating = false,
}: {
  initialRooms: RoomSummary[];
  agents: AgentOption[];
  startCreating?: boolean;
}) {
  const t = useT();
  const [rooms, setRooms] = useState(initialRooms);
  const [creating, setCreating] = useState(startCreating);
  const [settingsFor, setSettingsFor] = useState<RoomSummary | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? t('dashboard.rooms.agentFallback');

  async function remove(slug: string) {
    if (!window.confirm(t('dashboard.rooms.confirmDelete'))) return;
    try {
      await api(`/api/rooms/${encodeURIComponent(slug)}`, { method: 'DELETE', body: {} });
      setRooms(rooms.filter((r) => r.slug !== slug));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.rooms.deleteFailed'));
    }
  }

  async function setRoomAgents(slug: string, ids: string[], changed: string, on: boolean) {
    try {
      setError('');
      const { room, live } = await api<{
        room: RoomSummary;
        live: { removed: number; dispatched: number } | null;
      }>(`/api/rooms/${encodeURIComponent(slug)}`, { method: 'PATCH', body: { agentIds: ids } });
      setRooms((list) => list.map((r) => (r.slug === slug ? room : r)));
      const inMeeting = Boolean(live && (live.dispatched > 0 || live.removed > 0));
      const key: MessageKey = on
        ? inMeeting
          ? 'dashboard.rooms.agentJoinedMeeting'
          : 'dashboard.rooms.agentJoinedRoom'
        : inMeeting
          ? 'dashboard.rooms.agentLeftMeeting'
          : 'dashboard.rooms.agentLeftRoom';
      setNotice(t(key, { name: changed }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.rooms.updateFailed'));
    }
  }

  async function copyLink(slug: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/r/${slug}`);
    setCopied(slug);
    setTimeout(() => setCopied(''), 2000);
  }

  return (
    <>
      <div className="page-toolbar">
        <p className="muted" role="status" aria-live="polite">
          {notice || error || t('dashboard.rooms.count', { count: rooms.length })}
        </p>
        <button className="btn large" onClick={() => setCreating(true)}>
          <Icon name="add" size={22} />
          {t('dashboard.rooms.newRoom')}
        </button>
      </div>
      {rooms.length === 0 ? (
        <EmptyState
          icon="video_call"
          title={t('dashboard.rooms.emptyTitle')}
          action={
            <button className="btn tonal" onClick={() => setCreating(true)}>
              {t('dashboard.rooms.createFirst')}
            </button>
          }
        >
          {t('dashboard.rooms.emptyBody')}
        </EmptyState>
      ) : (
        <ul className="room-list">
          {rooms.map((room) => (
            <li key={room.slug} className="room-card">
              <span className="room-icon" aria-hidden>
                <Icon name={room.agentIds.length > 0 ? 'smart_toy' : 'videocam'} />
              </span>
              <div className="room-info">
                <strong>{room.name}</strong>
                <span className="room-link">/r/{room.slug}</span>
                <span className="chips">
                  {room.hasPassword && (
                    <span className="chip">
                      <Icon name="lock" size={14} /> {t('dashboard.rooms.chipPassword')}
                    </span>
                  )}
                  {!room.allowGuests && <span className="chip">{t('dashboard.rooms.chipMembersOnly')}</span>}
                  <span className="chip">
                    <Icon name={room.access === 'open' ? 'link' : 'lock'} size={14} />{' '}
                    {t(ACCESS_CHIP[room.access])}
                  </span>
                  {room.agentIds.map((id) => (
                    <span key={id} className="chip accent">
                      {t('dashboard.rooms.chipAgent', { name: agentName(id) })}
                    </span>
                  ))}
                </span>
              </div>
              <div className="room-actions">
                <button
                  className="icon-btn"
                  aria-label={t('dashboard.rooms.copyLinkLabel')}
                  data-tip={copied === room.slug ? t('common.copied') : t('dashboard.rooms.copyLink')}
                  onClick={() => copyLink(room.slug)}
                >
                  <Icon name={copied === room.slug ? 'check' : 'content_copy'} />
                </button>
                <RoomMenu
                  room={room}
                  agents={agents}
                  onAgents={(ids, changed, on) => setRoomAgents(room.slug, ids, changed, on)}
                  onSettings={() => setSettingsFor(room)}
                  onRemove={() => remove(room.slug)}
                />
                <Link className="btn small" href={`/r/${room.slug}`}>
                  {t('common.join')}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <CreateRoomWizard
          agents={agents}
          onCreated={(room) => setRooms((list) => [room, ...list])}
          onClose={() => {
            setCreating(false);
            if (startCreating) window.history.replaceState(null, '', '/dashboard');
          }}
        />
      )}
      {settingsFor && (
        <SettingsDialog
          room={settingsFor}
          onClose={() => setSettingsFor(null)}
          onChanged={(change) =>
            setRooms((list) => list.map((r) => (r.slug === settingsFor.slug ? { ...r, ...change } : r)))
          }
        />
      )}
    </>
  );
}

/** Native <dialog>: the browser traps focus, closes on Escape and announces it as modal. */
function SettingsDialog(props: {
  room: RoomSummary;
  onClose: () => void;
  onChanged: (change: Partial<RoomSummary>) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="room-settings-title" onClose={props.onClose}>
      <header className="dialog-head">
        <h2 id="room-settings-title">{t('dashboard.rooms.settingsTitle', { name: props.room.name })}</h2>
        <button className="icon-btn" aria-label={t('common.close')} onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <RoomSettingsEditor
        slug={props.room.slug}
        showAgent
        onChanged={(change) => {
          const { access, agentIds } = change;
          props.onChanged({ ...(access ? { access } : {}), ...(agentIds ? { agentIds } : {}) });
        }}
      />
    </dialog>
  );
}

function RoomMenu(props: {
  room: RoomSummary;
  agents: AgentOption[];
  onAgents: (agentIds: string[], changed: string, on: boolean) => void;
  onSettings: () => void;
  onRemove: () => void;
}) {
  const { room } = props;
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const full = room.agentIds.length >= MAX_ROOM_AGENTS;
  return (
    <div ref={anchor} className="popover-anchor">
      <button
        className="icon-btn"
        aria-label={t('dashboard.rooms.moreOptionsFor', { name: room.name })}
        aria-expanded={open}
        data-tip={t('common.moreOptions')}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more_vert" />
      </button>
      {open && (
        <div className="menu down end" role="menu">
          {props.agents.length > 0 && <p className="menu-label">{t('dashboard.rooms.menuAgents')}</p>}
          {props.agents.map((a) => {
            const on = room.agentIds.includes(a.id);
            return (
              <button
                key={a.id}
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={on}
                disabled={!on && (full || !a.ready)}
                onClick={() =>
                  props.onAgents(
                    on ? room.agentIds.filter((id) => id !== a.id) : [...room.agentIds, a.id],
                    a.name,
                    !on,
                  )
                }
              >
                <span className="menu-check">
                  <Icon name={on ? 'check_box' : 'check_box_outline_blank'} size={20} />
                </span>
                <span className="menu-text">
                  {a.name}
                  {a.description && <small className="menu-sub">{a.description}</small>}
                </span>
              </button>
            );
          })}
          <button className="menu-item divided" role="menuitem" onClick={run(props.onSettings)}>
            <span className="menu-check">
              <Icon name="how_to_reg" size={20} />
            </span>
            <span className="menu-text">{t('dashboard.rooms.menuSettings')}</span>
          </button>
          <button className="menu-item divided danger" role="menuitem" onClick={run(props.onRemove)}>
            <span className="menu-check">
              <Icon name="delete" size={20} />
            </span>
            <span className="menu-text">{t('dashboard.rooms.menuDelete')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
