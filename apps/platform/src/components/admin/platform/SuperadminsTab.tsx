'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../../api';
import { Icon } from '../../ui/Icon';

interface Row {
  userId: string;
  email: string;
  name: string;
  tenantSlug: string;
  tenantName: string;
  grantedAt: string;
  grantedByEmail: string | null;
}

interface Hit {
  id: string;
  email: string;
  name: string;
  tenantSlug: string;
}

export function SuperadminsTab({ selfId }: { selfId: string }) {
  const t = useT();
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api<Row[]>('/api/superadmin/grants'));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function search() {
    setBusy(true);
    try {
      setHits(await api<Hit[]>(`/api/superadmin/grants/search?q=${encodeURIComponent(q)}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function grant(userId: string) {
    setBusy(true);
    try {
      await api('/api/superadmin/grants', { method: 'POST', body: { userId } });
      setHits([]);
      setQ('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    if (!confirm(t('admin.superadmins.confirmRevoke'))) return;
    setBusy(true);
    try {
      await api(`/api/superadmin/grants/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="platform-page admin-stack">
      <header className="admin-head">
        <div>
          <h2>{t('admin.superadmins.title')}</h2>
          <p className="muted">{t('admin.superadmins.intro')}</p>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="card-block">
        <h3>{t('admin.superadmins.current')}</h3>
        <ul className="plain-list">
          {rows.map((r) => (
            <li key={r.userId} className="person-row">
              <span className="person-name">
                {r.name}
                <small>
                  {r.email} · {r.tenantName} ({r.tenantSlug})
                  {r.grantedByEmail ? ` · ${t('admin.superadmins.grantedBy', { email: r.grantedByEmail })}` : ''}
                </small>
              </span>
              {r.userId !== selfId && (
                <button className="btn text small" type="button" disabled={busy} onClick={() => void revoke(r.userId)}>
                  {t('admin.superadmins.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="card-block">
        <h3>{t('admin.superadmins.grant')}</h3>
        <p className="muted small-print">{t('admin.superadmins.grantHelp')}</p>
        <div className="row">
          <input
            className="field"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('admin.superadmins.searchPlaceholder')}
            aria-label={t('admin.superadmins.searchPlaceholder')}
          />
          <button className="btn tonal" type="button" disabled={busy || q.trim().length < 2} onClick={() => void search()}>
            <Icon name="search" size={20} />
            {t('common.search')}
          </button>
        </div>
        <ul className="plain-list">
          {hits.map((h) => (
            <li key={h.id} className="person-row">
              <span className="person-name">
                {h.name}
                <small>
                  {h.email} · {h.tenantSlug}
                </small>
              </span>
              <button className="btn small" type="button" disabled={busy} onClick={() => void grant(h.id)}>
                {t('admin.superadmins.grantBtn')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
