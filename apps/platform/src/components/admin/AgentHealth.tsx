'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { api } from '../api';
import { Icon } from '../ui/Icon';

interface HealthEvent {
  id: string;
  roomName: string;
  sessionId: string | null;
  at: string;
  kind: string;
  code: string;
  source: string | null;
  detail: string | null;
}

interface HealthSummary {
  status: 'ok' | 'silent' | 'error' | 'unknown';
  lastCode: string | null;
  lastKind: string | null;
  lastAt: string | null;
  lastRoom: string | null;
  lastSource: string | null;
  lastDetail: string | null;
  recent: HealthEvent[];
}

const CODE_KEYS: Record<string, MessageKey> = {
  ok: 'admin.agents.healthCode.ok',
  muted: 'admin.agents.healthCode.muted',
  not_addressed: 'admin.agents.healthCode.notAddressed',
  peers: 'admin.agents.healthCode.peers',
  listen_mode: 'admin.agents.healthCode.listenMode',
  config_missing: 'admin.agents.healthCode.configMissing',
  stt: 'admin.agents.healthCode.stt',
  llm: 'admin.agents.healthCode.llm',
  tts: 'admin.agents.healthCode.tts',
  other: 'admin.agents.healthCode.other',
};

const KIND_KEYS: Record<string, MessageKey> = {
  joined: 'admin.agents.healthKind.joined',
  left: 'admin.agents.healthKind.left',
  rejected: 'admin.agents.healthKind.rejected',
  pipeline_error: 'admin.agents.healthKind.pipelineError',
  skipped_reply: 'admin.agents.healthKind.skippedReply',
  muted: 'admin.agents.healthKind.muted',
  unmuted: 'admin.agents.healthKind.unmuted',
  answered: 'admin.agents.healthKind.answered',
};

function labelCode(t: ReturnType<typeof useT>, code: string | null): string {
  if (!code) return t('admin.agents.healthUnknown');
  const key = CODE_KEYS[code];
  return key ? t(key) : code;
}

function labelKind(t: ReturnType<typeof useT>, kind: string): string {
  const key = KIND_KEYS[kind];
  return key ? t(key) : kind;
}

function statusClass(status: HealthSummary['status']): string {
  if (status === 'error') return 'status-dot bad';
  if (status === 'silent') return 'status-dot warn';
  if (status === 'ok') return 'status-dot';
  return 'status-dot idle';
}

function statusLabel(t: ReturnType<typeof useT>, status: HealthSummary['status']): string {
  if (status === 'ok') return t('admin.agents.healthOk');
  if (status === 'silent') return t('admin.agents.healthSilent');
  if (status === 'error') return t('admin.agents.healthError');
  return t('admin.agents.healthUnknown');
}

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(locale, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Runtime trail: why this agent stayed quiet or hit STT/LLM/TTS errors. */
export function AgentHealthPanel(props: { agentId: string; locale: string }) {
  const t = useT();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    api<{ health: HealthSummary }>(`/api/admin/agents/${encodeURIComponent(props.agentId)}/health`)
      .then((r) => setHealth(r.health))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('admin.couldNotSave')))
      .finally(() => setBusy(false));
  }, [props.agentId, t]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="agent-health">
      <div className="agent-health-head">
        <p className="muted small-print">{t('admin.agents.healthIntro')}</p>
        <button type="button" className="btn tonal small" onClick={load} disabled={busy}>
          <Icon name="refresh" size={16} />
          {t('admin.agents.healthRefresh')}
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {health && (
        <>
          <p className="status-line" role="status">
            <span className={statusClass(health.status)} aria-hidden />
            <strong>{statusLabel(t, health.status)}</strong>
            {health.lastCode && (
              <>
                {' · '}
                {labelCode(t, health.lastCode)}
              </>
            )}
          </p>
          {health.lastAt && (
            <p className="muted small-print">
              {t('admin.agents.healthLastAt', {
                when: formatWhen(health.lastAt, props.locale),
                room: health.lastRoom ?? '—',
              })}
            </p>
          )}
          {health.recent.length === 0 ? (
            <p className="muted">{t('admin.agents.healthEmpty')}</p>
          ) : (
            <ul className="agent-health-list">
              {health.recent.slice(0, 25).map((ev) => (
                <li key={ev.id}>
                  <span className="agent-health-when">{formatWhen(ev.at, props.locale)}</span>
                  <strong>{labelKind(t, ev.kind)}</strong>
                  <span>{labelCode(t, ev.code)}</span>
                  <small className="muted">{ev.roomName}</small>
                  {ev.detail && <small className="muted mono">{ev.detail}</small>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
