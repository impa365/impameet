'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { DEFAULT_LOCALE, LOCALE_LABEL, LOCALES, type Locale, parseLocale } from '@/i18n/config';
import type { Branding } from '@/server/tenants/repo';
import { api } from '../api';
import { messageOf } from './useLoad';

export function BrandingTab({ initial }: { initial: Branding }) {
  const t = useT();
  const [form, setForm] = useState({
    ...initial,
    logoUrl: initial.logoUrl ?? '',
    defaultLocale: parseLocale(initial.defaultLocale) ?? DEFAULT_LOCALE,
  });
  const [status, setStatus] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus('');
    try {
      await api('/api/admin/branding', {
        method: 'PUT',
        body: {
          productName: form.productName,
          primaryColor: form.primaryColor,
          logoUrl: form.logoUrl.trim() || null,
          defaultLocale: form.defaultLocale,
        },
      });
      setStatus(t('admin.branding.saved'));
    } catch (err) {
      setStatus(messageOf(err, t('admin.branding.couldNotSave')));
    }
  }

  return (
    <form onSubmit={save} className="card form" style={{ maxWidth: 560, margin: 0 }}>
      <label>
        {t('admin.branding.productName')}
        <input
          required
          maxLength={60}
          value={form.productName}
          onChange={(e) => setForm({ ...form, productName: e.target.value })}
        />
      </label>
      <label>
        {t('admin.branding.primaryColor')}
        <div className="row">
          <input
            type="color"
            value={form.primaryColor}
            onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
            style={{ width: 56, padding: 2 }}
          />
          <input
            value={form.primaryColor}
            onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
          />
        </div>
      </label>
      <label>
        {t('admin.branding.logoUrl')}
        <input
          type="url"
          value={form.logoUrl}
          onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
        />
      </label>
      <label>
        {t('admin.branding.defaultLocale')}
        <select
          value={form.defaultLocale}
          onChange={(e) => setForm({ ...form, defaultLocale: e.target.value as Locale })}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l} lang={l}>
              {LOCALE_LABEL[l]}
            </option>
          ))}
        </select>
        <span className="muted">{t('admin.branding.defaultLocaleHint')}</span>
      </label>
      <button className="btn">{t('admin.branding.save')}</button>
      <div className="muted" role="status">
        {status}
      </div>
    </form>
  );
}
