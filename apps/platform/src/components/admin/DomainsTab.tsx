'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

interface Domain {
  hostname: string;
  verifiedAt: string | null;
  record: { name: string; value: string };
}

export function DomainsTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ target: string; domains: Domain[] }>(
    '/api/admin/domains',
  );
  const [hostname, setHostname] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/api/admin/domains', { body: { hostname } });
      setHostname('');
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.domains.couldNotAdd')));
    }
  }

  async function verify(host: string) {
    try {
      await api(`/api/admin/domains/${encodeURIComponent(host)}`, { body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.domains.verifyFailed')));
    }
  }

  async function remove(host: string) {
    if (!window.confirm(t('admin.domains.confirmRemove', { host }))) return;
    try {
      await api(`/api/admin/domains/${encodeURIComponent(host)}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.domains.couldNotRemove')));
    }
  }

  return (
    <>
      <form onSubmit={add} className="card form" style={{ maxWidth: 'none', marginBottom: 20 }}>
        <strong>{t('admin.domains.title')}</strong>
        <div className="row">
          <input
            required
            placeholder={t('admin.domains.placeholder')}
            value={hostname}
            onChange={(e) => setHostname(e.target.value.toLowerCase())}
          />
          <button className="btn">{t('common.add')}</button>
        </div>
      </form>
      <div className="error" role="alert">
        {error}
      </div>
      {data?.domains.map((d) => (
        <div key={d.hostname} className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{d.hostname}</strong>
            <span className="badge">
              {d.verifiedAt ? t('admin.domains.verified') : t('admin.domains.awaitingDns')}
            </span>
          </div>
          {!d.verifiedAt && (
            <>
              <p className="muted">{t('admin.domains.createRecords')}</p>
              <div>{t('admin.domains.cnameRecord')}</div>
              <code className="record">
                {d.hostname} → {data.target}
              </code>
              <div>{t('admin.domains.txtRecord')}</div>
              <code className="record">
                {d.record.name} = {d.record.value}
              </code>
            </>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            {!d.verifiedAt && (
              <button className="btn small" onClick={() => verify(d.hostname)}>
                {t('admin.domains.verifyNow')}
              </button>
            )}
            <button className="btn danger small" onClick={() => remove(d.hostname)}>
              {t('admin.domains.remove')}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
