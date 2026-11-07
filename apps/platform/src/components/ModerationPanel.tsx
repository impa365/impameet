'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from './api';
import { Avatar } from './meet/Avatar';
import { displayName } from './meet/MeetTile';
import { Icon } from './ui/Icon';

interface Participant {
  identity: string;
  name: string;
  role: string;
  isAgent: boolean;
  handRaised: boolean;
  audioMuted: boolean;
}

interface LobbyRequest {
  id: string;
  displayName: string;
  userId: string | null;
}

interface State {
  canModerate: boolean;
  participants: Participant[];
  lobby: LobbyRequest[];
}

/** The moderator's view of the people panel; anyone the server does not let moderate sees `fallback`. */
export function ModerationView({ slug, fallback }: { slug: string; fallback: ReactNode }) {
  const t = useT();
  const base = `/api/rooms/${encodeURIComponent(slug)}`;
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setState(await api<State>(`${base}/moderation`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.moderation.loadFailed'));
    }
  }, [base, t]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(action: string, identity?: string) {
    setError('');
    try {
      await api(`${base}/moderation`, { body: { action, identity } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.moderation.actionFailed'));
    }
  }

  async function decide(id: string, approve: boolean) {
    setError('');
    try {
      await api(`${base}/lobby`, { body: { id, approve } });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.moderation.actionFailed'));
    }
  }

  if (state && !state.canModerate) return fallback;

  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!state && <p className="muted">{t('room.moderation.loading')}</p>}
      {state?.canModerate && (
        <>
          {state.lobby.length > 0 && (
            <section className="people-section">
              <h4>{t('room.moderation.asking', { count: state.lobby.length })}</h4>
              {state.lobby.map((r) => (
                <div key={r.id} className="person-row">
                  <Avatar name={r.displayName} />
                  <span className="person-name">
                    {r.displayName}
                    {!r.userId && <small>{t('room.guestLower')}</small>}
                  </span>
                  <span className="person-actions">
                    <button className="btn small" onClick={() => decide(r.id, true)}>
                      {t('room.moderation.admit')}
                    </button>
                    <button className="btn text small" onClick={() => decide(r.id, false)}>
                      {t('room.moderation.deny')}
                    </button>
                  </span>
                </div>
              ))}
            </section>
          )}
          <section className="people-section">
            <div className="people-section-head">
              <h4>{t('room.people.inMeeting', { count: state.participants.length })}</h4>
              <button className="btn text small" onClick={() => act('mute_all')}>
                <Icon name="mic_off" size={18} />
                {t('room.moderation.muteAll')}
              </button>
            </div>
            {state.participants
              .map((raw) => ({ ...raw, name: displayName(raw, t('room.aiAssistant')) }))
              .map((p) => (
                <div key={p.identity} className="person-row">
                  <Avatar name={p.name} agent={p.isAgent} />
                  <span className="person-name">
                    {p.name}
                    <small>
                      {[
                        p.isAgent && t('room.aiAssistant'),
                        p.role === 'moderator' && t('room.moderator'),
                        p.role === 'guest' && t('room.guest'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                  <span className="person-actions">
                    {p.handRaised && <Icon name="back_hand" size={20} className="person-hand" />}
                    {p.audioMuted ? (
                      <span className="icon-btn ghost" title={t('room.status.micOff')}>
                        <Icon name="mic_off" size={20} />
                      </span>
                    ) : (
                      <button
                        className="icon-btn"
                        title={t('room.device.micOff')}
                        aria-label={t('room.moderation.muteName', { name: p.name })}
                        onClick={() => act('mute', p.identity)}
                      >
                        <Icon name="mic" size={20} />
                      </button>
                    )}
                    {!p.isAgent &&
                      (p.role === 'moderator' ? (
                        <button
                          className="icon-btn"
                          title={t('room.moderation.demote')}
                          aria-label={t('room.moderation.demoteName', { name: p.name })}
                          onClick={() => act('demote', p.identity)}
                        >
                          <Icon name="remove_moderator" size={20} />
                        </button>
                      ) : (
                        <button
                          className="icon-btn"
                          title={t('room.moderation.promote')}
                          aria-label={t('room.moderation.promoteName', { name: p.name })}
                          onClick={() => act('promote', p.identity)}
                        >
                          <Icon name="shield_person" size={20} />
                        </button>
                      ))}
                    <button
                      className="icon-btn danger"
                      title={t('room.moderation.remove')}
                      aria-label={t('room.moderation.removeName', { name: p.name })}
                      onClick={() =>
                        window.confirm(t('room.moderation.removeConfirm', { name: p.name })) &&
                        act('remove', p.identity)
                      }
                    >
                      <Icon name="person_remove" size={20} />
                    </button>
                  </span>
                </div>
              ))}
          </section>
        </>
      )}
    </>
  );
}
