'use client';

import { useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { useLoad } from './useLoad';

interface Entry {
  id: string;
  action: string;
  target: string | null;
  actorName: string | null;
  ip: string | null;
  createdAt: string;
}

/** Codes written by the server's audit log; unknown ones are shown raw. */
const ACTION_LABEL: Partial<Record<string, MessageKey>> = {
  'auth.login': 'admin.audit.actions.auth.login',
  'auth.login_failed': 'admin.audit.actions.auth.login_failed',
  'tenant.created': 'admin.audit.actions.tenant.created',
  'tenant.updated': 'admin.audit.actions.tenant.updated',
  'branding.updated': 'admin.audit.actions.branding.updated',
  'user.created': 'admin.audit.actions.user.created',
  'user.updated': 'admin.audit.actions.user.updated',
  'domain.added': 'admin.audit.actions.domain.added',
  'domain.verified': 'admin.audit.actions.domain.verified',
  'domain.removed': 'admin.audit.actions.domain.removed',
  'room.created': 'admin.audit.actions.room.created',
  'room.updated': 'admin.audit.actions.room.updated',
  'room.deleted': 'admin.audit.actions.room.deleted',
  'room.invites': 'admin.audit.actions.room.invites',
  'meeting.scheduled': 'admin.audit.actions.meeting.scheduled',
  'meeting.cancelled': 'admin.audit.actions.meeting.cancelled',
  'agent.created': 'admin.audit.actions.agent.created',
  'agent.updated': 'admin.audit.actions.agent.updated',
  'agent.default': 'admin.audit.actions.agent.default',
  'agent.deleted': 'admin.audit.actions.agent.deleted',
  'integration.created': 'admin.audit.actions.integration.created',
  'integration.updated': 'admin.audit.actions.integration.updated',
  'integration.deleted': 'admin.audit.actions.integration.deleted',
  'breakouts.opened': 'admin.audit.actions.breakouts.opened',
  'breakouts.closed': 'admin.audit.actions.breakouts.closed',
  'captions.started': 'admin.audit.actions.captions.started',
  'captions.stopped': 'admin.audit.actions.captions.stopped',
  'transcript.saved': 'admin.audit.actions.transcript.saved',
  'transcript.deleted': 'admin.audit.actions.transcript.deleted',
  'recording.started': 'admin.audit.actions.recording.started',
  'recording.stopped': 'admin.audit.actions.recording.stopped',
  'recording.deleted': 'admin.audit.actions.recording.deleted',
};

export function AuditTab() {
  const t = useT();
  const locale = useLocale();
  const { data, error } = useLoad<{ entries: Entry[] }>('/api/admin/audit');
  if (error) return <div className="error">{error}</div>;
  return (
    <div className="table-card">
      <table className="grid">
        <thead>
          <tr>
            <th>{t('admin.audit.when')}</th>
            <th>{t('admin.audit.who')}</th>
            <th>{t('admin.audit.action')}</th>
            <th>{t('admin.audit.target')}</th>
            <th>{t('admin.audit.ip')}</th>
          </tr>
        </thead>
        <tbody>
          {data?.entries.map((e) => {
            const label = ACTION_LABEL[e.action];
            return (
              <tr key={e.id}>
                <td className="muted">{new Date(e.createdAt).toLocaleString(locale)}</td>
                <td>{e.actorName ?? '—'}</td>
                <td>{label ? <span title={e.action}>{t(label)}</span> : <code>{e.action}</code>}</td>
                <td>{e.target ?? ''}</td>
                <td className="muted">{e.ip ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
