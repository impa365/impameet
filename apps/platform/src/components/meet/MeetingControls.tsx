'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';

type CollabPolicy = 'everyone' | 'moderators';

interface Controls {
  boardPolicy: CollabPolicy;
  pollsPolicy: CollabPolicy;
  thinkingSound: boolean;
  agentActions: boolean;
}

/**
 * The meeting's controls for a moderator promoted during it (signed in or a guest): who may
 * draw and create polls, and what the AI does. Access, invites and the room's agents stay with
 * the organizer.
 */
export function MeetingControls(props: {
  slug: string;
  token: string;
  onChanged: (change: Partial<Controls>) => void;
}) {
  const t = useT();
  const path = `/api/rooms/${encodeURIComponent(props.slug)}/controls`;
  const headers = { 'x-room-token': props.token };
  const [controls, setControls] = useState<Controls | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api<{ canControl: boolean } & Partial<Controls>>(path, {
        headers: { 'x-room-token': props.token },
      });
      setControls(res.canControl ? (res as Controls) : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.controls.loadFailed'));
    }
  }, [path, props.token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(patch: Partial<Controls>, done: string) {
    setBusy(true);
    setError('');
    try {
      const next = await api<Controls>(path, { body: patch, headers });
      setControls(next);
      props.onChanged(patch);
      setStatus(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('room.controls.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!controls)
    return error ? <p className="error">{error}</p> : <p className="muted">{t('common.loading')}</p>;

  return (
    <div className="room-settings">
      <p className="muted small-print">{t('room.controls.intro')}</p>
      <fieldset className="group" disabled={busy}>
        <legend>{t('dashboard.roomSettings.permissions')}</legend>
        <label className="field-row">
          <span>{t('dashboard.roomSettings.whiteboard')}</span>
          <select
            value={controls.boardPolicy}
            onChange={(e) =>
              void change(
                { boardPolicy: e.target.value as CollabPolicy },
                t('dashboard.roomSettings.boardUpdated'),
              )
            }
          >
            <option value="everyone">{t('dashboard.roomSettings.boardEveryone')}</option>
            <option value="moderators">{t('dashboard.roomSettings.boardModerators')}</option>
          </select>
        </label>
        <label className="field-row">
          <span>{t('dashboard.roomSettings.polls')}</span>
          <select
            value={controls.pollsPolicy}
            onChange={(e) =>
              void change(
                { pollsPolicy: e.target.value as CollabPolicy },
                t('dashboard.roomSettings.pollsUpdated'),
              )
            }
          >
            <option value="everyone">{t('dashboard.roomSettings.pollsEveryone')}</option>
            <option value="moderators">{t('dashboard.roomSettings.pollsModerators')}</option>
          </select>
        </label>
      </fieldset>
      <fieldset className="group" disabled={busy}>
        <legend>{t('dashboard.roomSettings.agentsLegend')}</legend>
        <label className="switch">
          <input
            type="checkbox"
            checked={controls.agentActions}
            onChange={(e) =>
              void change(
                { agentActions: e.target.checked },
                t(
                  e.target.checked
                    ? 'dashboard.roomSettings.agentActionsOn'
                    : 'dashboard.roomSettings.agentActionsOff',
                ),
              )
            }
          />
          <span>
            {t('dashboard.roomSettings.agentActions')}
            <small>{t('dashboard.roomSettings.agentActionsHint')}</small>
          </span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={controls.thinkingSound}
            onChange={(e) =>
              void change(
                { thinkingSound: e.target.checked },
                t(
                  e.target.checked
                    ? 'dashboard.roomSettings.thinkingOn'
                    : 'dashboard.roomSettings.thinkingOff',
                ),
              )
            }
          />
          <span>
            {t('dashboard.roomSettings.thinkingSound')}
            <small>{t('dashboard.roomSettings.thinkingHint')}</small>
          </span>
        </label>
      </fieldset>
      <div className="error" role="alert">
        {error}
      </div>
      <div className="muted" role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}
