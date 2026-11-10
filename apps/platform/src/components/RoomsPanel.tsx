'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { type AgentChoice, type RoomAccess, RoomSettingsEditor } from './RoomSettings';
import { CreateRoomWizard } from './CreateRoomWizard';
import { ApiError, api } from './api';
import { EmptyState } from './ui/EmptyState';
import { Icon } from './ui/Icon';

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

/** What the rooms view shows, mirrored in the address so Back and reload keep the place. */
type View = { kind: 'list' } | { kind: 'new' } | { kind: 'room'; slug: string };

function viewFromUrl(): View {
  const params = new URLSearchParams(window.location.search);
  if (params.get('new') === '1') return { kind: 'new' };
  const slug = params.get('room');
  return slug ? { kind: 'room', slug } : { kind: 'list' };
}

const urlFor = (view: View) =>
  view.kind === 'new'
    ? '/dashboard?new=1'
    : view.kind === 'room'
      ? `/dashboard?room=${encodeURIComponent(view.slug)}`
      : '/dashboard';

export function RoomsPanel({
  initialRooms,
  agents,
  startCreating = false,
  startRoom,
}: {
  initialRooms: RoomSummary[];
  agents: AgentOption[];
  startCreating?: boolean;
  startRoom?: string;
}) {
  const t = useT();
  const [rooms, setRooms] = useState(initialRooms);
  const [view, setView] = useState<View>(
    startCreating ? { kind: 'new' } : startRoom ? { kind: 'room', slug: startRoom } : { kind: 'list' },
  );
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const agentName = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? t('dashboard.rooms.agentFallback');

  useEffect(() => {
    const onPop = () => setView(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function go(next: View) {
    window.history.pushState(null, '', urlFor(next));
    setView(next);
    window.scrollTo({ top: 0 });
  }

  async function remove(room: RoomSummary) {
    if (!window.confirm(t('dashboard.rooms.confirmDelete'))) return;
    try {
      await api(`/api/rooms/${encodeURIComponent(room.slug)}`, { method: 'DELETE', body: {} });
      setRooms((list) => list.filter((r) => r.slug !== room.slug));
      if (view.kind === 'room') go({ kind: 'list' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.rooms.deleteFailed'));
    }
  }

  async function copyLink(slug: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/r/${slug}`).catch(() => undefined);
    setCopied(slug);
    setTimeout(() => setCopied(''), 2000);
  }

  if (view.kind === 'new') {
    return (
      <CreateRoomWizard
        agents={agents}
        onCreated={(room) => setRooms((list) => [room, ...list])}
        onClose={() => go({ kind: 'list' })}
      />
    );
  }

  const open = view.kind === 'room' ? rooms.find((r) => r.slug === view.slug) : undefined;
  if (open) {
    return (
      <div className="settings-body room-page">
        <div className="settings-head">
          <button type="button" className="btn text small back-link" onClick={() => go({ kind: 'list' })}>
            <Icon name="arrow_back" size={18} />
            {t('dashboard.rooms.backToRooms')}
          </button>
          <h2>{open.name}</h2>
          <span className="status-line">
            <Icon name="link" size={16} />
            /r/{open.slug}
          </span>
          <div className="row add-row">
            <Link className="btn small" href={`/r/${open.slug}`}>
              <Icon name="video_call" size={18} />
              {t('common.join')}
            </Link>
            <button type="button" className="btn secondary small" onClick={() => void copyLink(open.slug)}>
              <Icon name={copied === open.slug ? 'check' : 'content_copy'} size={18} />
              {copied === open.slug ? t('common.copied') : t('dashboard.rooms.copyLink')}
            </button>
            <button type="button" className="btn text danger small" onClick={() => void remove(open)}>
              <Icon name="delete" size={18} />
              {t('dashboard.rooms.menuDelete')}
            </button>
          </div>
        </div>
        <div className="error" role="alert">
          {error}
        </div>
        <RoomSettingsEditor
          slug={open.slug}
          showAgent
          onChanged={(change) => {
            const { access, agentIds } = change;
            setRooms((list) =>
              list.map((r) =>
                r.slug === open.slug
                  ? { ...r, ...(access ? { access } : {}), ...(agentIds ? { agentIds } : {}) }
                  : r,
              ),
            );
          }}
        />
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <p role="status" aria-live="polite">
          {error || t('dashboard.rooms.count', { count: rooms.length })}
        </p>
        <button className="btn" onClick={() => go({ kind: 'new' })}>
          <Icon name="add" size={18} />
          {t('dashboard.rooms.newRoom')}
        </button>
      </div>
      {rooms.length === 0 ? (
        <EmptyState
          icon="video_call"
          title={t('dashboard.rooms.emptyTitle')}
          action={
            <button className="btn tonal" onClick={() => go({ kind: 'new' })}>
              {t('dashboard.rooms.createFirst')}
            </button>
          }
        >
          {t('dashboard.rooms.emptyBody')}
        </EmptyState>
      ) : (
        <ul className="card-list">
          {rooms.map((room) => (
            <li key={room.slug} className="tile">
              <div className="tile-body">
                <div className="tile-head">
                  <span className="tile-avatar" aria-hidden>
                    <Icon name={room.agentIds.length > 0 ? 'smart_toy' : 'videocam'} size={22} />
                  </span>
                  <div className="tile-title">
                    <strong>{room.name}</strong>
                    <span className="muted">/r/{room.slug}</span>
                  </div>
                </div>
                <span className="chips">
                  <span className="chip">
                    <Icon name={room.access === 'open' ? 'link' : 'lock'} size={14} />{' '}
                    {t(ACCESS_CHIP[room.access])}
                  </span>
                  {room.hasPassword && (
                    <span className="chip">
                      <Icon name="key" size={14} /> {t('dashboard.rooms.chipPassword')}
                    </span>
                  )}
                  {!room.allowGuests && <span className="chip">{t('dashboard.rooms.chipMembersOnly')}</span>}
                </span>
                <dl className="tile-facts">
                  <div>
                    <dt>
                      <Icon name="smart_toy" size={16} />
                      {t('dashboard.rooms.agentsFact')}
                    </dt>
                    <dd>
                      {room.agentIds.length > 0 ? (
                        room.agentIds.map(agentName).join(', ')
                      ) : (
                        <span className="unset">{t('dashboard.rooms.noAgent')}</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="tile-actions">
                <Link className="btn small" href={`/r/${room.slug}`}>
                  {t('common.join')}
                </Link>
                <button className="btn text small" onClick={() => void copyLink(room.slug)}>
                  <Icon name={copied === room.slug ? 'check' : 'content_copy'} size={16} />
                  {copied === room.slug ? t('common.copied') : t('dashboard.rooms.copyLink')}
                </button>
                <button className="btn text small" onClick={() => go({ kind: 'room', slug: room.slug })}>
                  <Icon name="edit" size={16} />
                  {t('common.edit')}
                </button>
                <button
                  className="btn text danger small icon-only"
                  aria-label={t('dashboard.rooms.deleteRoom', { name: room.name })}
                  data-tip={t('dashboard.rooms.menuDelete')}
                  onClick={() => void remove(room)}
                >
                  <Icon name="delete" size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
