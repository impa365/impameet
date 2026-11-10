'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
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
      <form onSubmit={add} className="form settings-section panel-form">
        <header className="section-head">
          <h3>{t('admin.domains.title')}</h3>
          <p>{t('admin.domains.intro')}</p>
        </header>
        <div className="row inline-add">
          <input
            required
            aria-label={t('admin.domains.title')}
            placeholder={t('admin.domains.placeholder')}
            value={hostname}
            onChange={(e) => setHostname(e.target.value.toLowerCase())}
          />
          <button className="btn">
            <Icon name="add" size={18} />
            {t('common.add')}
          </button>
        </div>
      </form>
      <div className="error" role="alert">
        {error}
      </div>
      {data?.domains.map((d) => (
        <section key={d.hostname} className="settings-section panel-form" aria-label={d.hostname}>
          <div className="int-group-head">
            <div className="section-head">
              <h3>{d.hostname}</h3>
              <span className="status-line">
                <span className={d.verifiedAt ? 'status-dot' : 'status-dot warn'} aria-hidden />
                {d.verifiedAt ? t('admin.domains.verified') : t('admin.domains.awaitingDns')}
              </span>
            </div>
            <div className="row-actions">
              <button className="btn text danger small" onClick={() => remove(d.hostname)}>
                {t('admin.domains.remove')}
              </button>
              {!d.verifiedAt && (
                <button className="btn small" onClick={() => verify(d.hostname)}>
                  {t('admin.domains.verifyNow')}
                </button>
              )}
            </div>
          </div>
          {!d.verifiedAt && (
            <div className="dns-records">
              <span className="field-help">{t('admin.domains.createRecords')}</span>
              <span>{t('admin.domains.cnameRecord')}</span>
              <code className="record">
                {d.hostname} → {data.target}
              </code>
              <span>{t('admin.domains.txtRecord')}</span>
              <code className="record">
                {d.record.name} = {d.record.value}
              </code>
            </div>
          )}
        </section>
      ))}
    </>
  );
}
