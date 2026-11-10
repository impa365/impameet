'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

/** The organization's sign-in policy: whether everyone must use two-step verification. */
export function SecurityTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{
    security: { requireMfa: boolean; users: number; withMfa: number };
  }>('/api/admin/security');
  const s = data?.security;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  async function toggle(required: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/admin/security', { method: 'PUT', body: { required } });
      await reload();
      setNotice(t('security.admin.saved'));
    } catch (err) {
      setError(messageOf(err, t('security.account.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  const pct = s && s.users > 0 ? Math.round((s.withMfa / s.users) * 100) : 0;
  return (
    <div className="settings-body">
      <div className="page-head">
        <p>{t('security.admin.intro')}</p>
      </div>
      <section className="settings-section">
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(s?.requireMfa)}
            disabled={busy || !s}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>
            {t('security.admin.requireTitle')}
            <small>{t('security.admin.requireHint')}</small>
          </span>
        </label>
        {s && (
          <div className="security-adoption">
            <span className="kb-meter" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="muted">{t('security.admin.adoption', { with: s.withMfa, total: s.users })}</span>
          </div>
        )}
        <Link href="/account" className="btn secondary small security-own">
          <Icon name="verified_user" size={16} />
          {t('security.admin.yourAccount')}
        </Link>
        {notice && (
          <p className="muted" role="status">
            {notice}
          </p>
        )}
        <div className="error" role="alert">
          {error}
        </div>
      </section>
    </div>
  );
}
