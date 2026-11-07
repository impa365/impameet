'use client';

import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { ApiError, api } from './api';

export type RoomAccess = 'open' | 'trusted' | 'restricted';
export type CollabPolicy = 'everyone' | 'moderators';

export const ACCESS_LABEL: Record<RoomAccess, MessageKey> = {
  open: 'dashboard.roomSettings.access.open',
  trusted: 'dashboard.roomSettings.access.trusted',
  restricted: 'dashboard.roomSettings.access.restricted',
};

const ACCESS_HELP: Record<RoomAccess, MessageKey> = {
  open: 'dashboard.roomSettings.accessHelp.open',
  trusted: 'dashboard.roomSettings.accessHelp.trusted',
  restricted: 'dashboard.roomSettings.accessHelp.restricted',
};

const ACCESS_CHANGED: Record<RoomAccess, MessageKey> = {
  open: 'dashboard.roomSettings.accessChanged.open',
  trusted: 'dashboard.roomSettings.accessChanged.trusted',
  restricted: 'dashboard.roomSettings.accessChanged.restricted',
};

export interface AgentChoice {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  /** Has every provider, model and voice chosen; others cannot be put in a room. */
  ready: boolean;
}

export const MAX_ROOM_AGENTS = 4;

interface Settings {
  canManage: boolean;
  access: RoomAccess;
  allowGuests: boolean;
  boardPolicy: CollabPolicy;
  pollsPolicy: CollabPolicy;
  thinkingSound: boolean;
  invites: string[];
  agentsAllowed: boolean;
  agentIds: string[];
  agents: AgentChoice[];
}

/** The organizer's settings that are fetched only when someone opens them (no cost otherwise). */
export function useRoomSettings(slug: string, enabled: boolean) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = useCallback(async () => {
    const s = await api<Settings | { canManage: false }>(
      `/api/rooms/${encodeURIComponent(slug)}/access`,
    ).catch(() => null);
    setSettings(s && s.canManage ? (s as Settings) : null);
    return s?.canManage ?? false;
  }, [slug]);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { settings, setSettings, reload };
}

/**
 * Who enters without asking (Google Meet's open / trusted / restricted), the invite list,
 * whiteboard and polls permissions and, inside a call, the room's AI agent.
 */
export function RoomSettingsEditor(props: {
  slug: string;
  showAgent?: boolean;
  onChanged?: (patch: Partial<Settings>, live?: { removed: number; dispatched: number } | null) => void;
}) {
  const { slug } = props;
  const t = useT();
  const { settings, setSettings } = useRoomSettings(slug, true);
  const [invites, setInvites] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    if (settings) setInvites(settings.invites.join('\n'));
  }, [settings?.invites]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the saved list changes

  async function patch(change: Partial<Settings>, done: string) {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ live: { removed: number; dispatched: number } | null }>(
        `/api/rooms/${encodeURIComponent(slug)}`,
        { method: 'PATCH', body: change },
      );
      setSettings((s) => (s ? { ...s, ...change } : s));
      setStatus(done);
      props.onChanged?.(change, res.live);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.roomSettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function saveInvites(e: FormEvent) {
    e.preventDefault();
    const emails = invites
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    setError('');
    try {
      const res = await api<{ invites: string[] }>(`/api/rooms/${encodeURIComponent(slug)}/access`, {
        method: 'PUT',
        body: { emails },
      });
      setSettings((s) => (s ? { ...s, invites: res.invites } : s));
      setStatus(t('dashboard.roomSettings.listSaved', { count: res.invites.length }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('dashboard.roomSettings.saveListFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <p className="muted">{t('dashboard.roomSettings.loading')}</p>;

  return (
    <div className="room-settings">
      <fieldset className="group" disabled={busy}>
        <legend>{t('dashboard.roomSettings.accessLegend')}</legend>
        {(Object.keys(ACCESS_LABEL) as RoomAccess[]).map((a) => (
          <label key={a} className="radio-row">
            <input
              type="radio"
              name={`${id}-access`}
              checked={settings.access === a}
              onChange={() => void patch({ access: a }, t(ACCESS_CHANGED[a]))}
            />
            <span>
              <strong>{t(ACCESS_LABEL[a])}</strong>
              <small>{t(ACCESS_HELP[a])}</small>
            </span>
          </label>
        ))}
        <p className="muted small-print">{t('dashboard.roomSettings.accessNote')}</p>
      </fieldset>

      <form className="group-form" onSubmit={saveInvites}>
        <label htmlFor={`${id}-invites`}>
          <strong>{t('dashboard.roomSettings.invitesLabel')}</strong>
          <small className="muted"> {t('dashboard.roomSettings.invitesHint')}</small>
        </label>
        <textarea
          id={`${id}-invites`}
          rows={4}
          value={invites}
          onChange={(e) => setInvites(e.target.value)}
          placeholder={t('dashboard.roomSettings.invitesPlaceholder')}
          disabled={busy}
        />
        <button className="btn small" disabled={busy}>
          {t('dashboard.roomSettings.saveList')}
        </button>
      </form>

      <fieldset className="group" disabled={busy}>
        <legend>{t('dashboard.roomSettings.permissions')}</legend>
        <label className="field-row">
          <span>{t('dashboard.roomSettings.whiteboard')}</span>
          <select
            value={settings.boardPolicy}
            onChange={(e) =>
              void patch(
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
            value={settings.pollsPolicy}
            onChange={(e) =>
              void patch(
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

      {props.showAgent && settings.agentsAllowed && (
        <fieldset className="group" disabled={busy}>
          <legend>{t('dashboard.roomSettings.agentsLegend')}</legend>
          <AgentChecklist
            agents={settings.agents}
            selected={settings.agentIds}
            onChange={(agentIds, name, on) =>
              void patch(
                { agentIds },
                t(on ? 'dashboard.roomSettings.agentAdded' : 'dashboard.roomSettings.agentRemoved', { name }),
              )
            }
          />
          <p className="muted small-print">{t('dashboard.roomSettings.agentsNote')}</p>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.thinkingSound}
              onChange={(e) =>
                void patch(
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
      )}
      <div className="error" role="alert">
        {error}
      </div>
      <div className="muted" role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}

/** One checkbox per agent: checked agents join the room's meetings, unchecked ones leave. */
export function AgentChecklist(props: {
  agents: AgentChoice[];
  selected: string[];
  onChange: (agentIds: string[], name: string, on: boolean) => void;
}) {
  const t = useT();
  const full = props.selected.length >= MAX_ROOM_AGENTS;
  if (props.agents.length === 0) return <p className="muted">{t('dashboard.roomSettings.noAgents')}</p>;
  return (
    <div className="agent-checklist">
      {props.agents.map((a) => {
        const on = props.selected.includes(a.id);
        return (
          <label key={a.id} className="agent-check">
            <input
              type="checkbox"
              checked={on}
              disabled={!on && (full || !a.ready)}
              onChange={(e) =>
                props.onChange(
                  e.target.checked ? [...props.selected, a.id] : props.selected.filter((id) => id !== a.id),
                  a.name,
                  e.target.checked,
                )
              }
            />
            <span>
              <strong>
                {a.name}
                {a.isDefault ? ` ${t('dashboard.roomSettings.defaultTag')}` : ''}
              </strong>
              {a.description && <small>{a.description}</small>}
              {!a.ready && <small className="warn-text">{t('dashboard.roomSettings.agentIncomplete')}</small>}
            </span>
          </label>
        );
      })}
      {full && (
        <p className="muted small-print">
          {t('dashboard.roomSettings.agentLimit', { max: MAX_ROOM_AGENTS })}
        </p>
      )}
    </div>
  );
}
