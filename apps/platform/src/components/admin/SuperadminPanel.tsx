'use client';

import { useT } from '@/i18n/client';
import { api } from '../api';
import { PlatformMail } from './PlatformMail';
import { messageOf, useLoad } from './useLoad';

interface Limits {
  maxRooms: number | null;
  maxParticipants: number | null;
  agents: boolean;
  customDomains: boolean;
  recording: boolean;
}

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
  limits: Limits;
  users: number;
  rooms: number;
  domains: number;
  createdAt: string;
}

const PLANS = ['free', 'pro', 'enterprise'];

function parseLimit(value: string): number | null {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function SuperadminPanel({ selfTenantId }: { selfTenantId: string }) {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ tenants: Tenant[] }>('/api/superadmin/tenants');

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/api/superadmin/tenants/${id}`, { method: 'PATCH', body });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotSave')));
    }
  }

  return (
    <>
      <p className="muted">{t('admin.superadmin.intro')}</p>
      <div className="error" role="alert">
        {error}
      </div>
      <div className="table-card">
        <table className="grid">
          <thead>
            <tr>
              <th>{t('admin.superadmin.organization')}</th>
              <th>{t('admin.superadmin.plan')}</th>
              <th>{t('admin.superadmin.roomsLimit')}</th>
              <th>{t('admin.superadmin.participantsPerRoom')}</th>
              <th>{t('admin.superadmin.ai')}</th>
              <th>{t('admin.superadmin.customDomain')}</th>
              <th>{t('admin.superadmin.recording')}</th>
              <th>{t('admin.superadmin.usage')}</th>
              <th>{t('admin.status')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td>
                  <strong>{tenant.name}</strong>
                  <div className="muted">{tenant.slug}</div>
                </td>
                <td>
                  <select
                    value={tenant.plan}
                    onChange={(e) => patch(tenant.id, { plan: e.target.value, limits: {} })}
                  >
                    {PLANS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    defaultValue={tenant.limits.maxRooms ?? ''}
                    placeholder={t('admin.superadmin.unlimited')}
                    style={{ width: 100 }}
                    onBlur={(e) =>
                      patch(tenant.id, { limits: { ...tenant.limits, maxRooms: parseLimit(e.target.value) } })
                    }
                  />
                </td>
                <td>
                  <input
                    defaultValue={tenant.limits.maxParticipants ?? ''}
                    placeholder={t('admin.superadmin.unlimited')}
                    style={{ width: 100 }}
                    onBlur={(e) =>
                      patch(tenant.id, {
                        limits: { ...tenant.limits, maxParticipants: parseLimit(e.target.value) },
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={tenant.limits.agents}
                    onChange={(e) =>
                      patch(tenant.id, { limits: { ...tenant.limits, agents: e.target.checked } })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={tenant.limits.customDomains}
                    onChange={(e) =>
                      patch(tenant.id, { limits: { ...tenant.limits, customDomains: e.target.checked } })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={tenant.limits.recording}
                    onChange={(e) =>
                      patch(tenant.id, { limits: { ...tenant.limits, recording: e.target.checked } })
                    }
                  />
                </td>
                <td className="muted">
                  {t('admin.superadmin.usageSummary', {
                    users: tenant.users,
                    rooms: tenant.rooms,
                    domains: tenant.domains,
                  })}
                </td>
                <td>
                  {tenant.id === selfTenantId ? (
                    <span className="badge">{t('admin.superadmin.yourOrganization')}</span>
                  ) : (
                    <button
                      className={tenant.status === 'active' ? 'btn danger small' : 'btn small'}
                      onClick={() =>
                        patch(tenant.id, { status: tenant.status === 'active' ? 'suspended' : 'active' })
                      }
                    >
                      {tenant.status === 'active' ? t('admin.superadmin.suspend') : t('admin.reactivate')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PlatformMail />
    </>
  );
}
