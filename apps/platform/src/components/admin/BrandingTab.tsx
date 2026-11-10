'use client';

import { type CSSProperties, type FormEvent, useState } from 'react';
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

  const color = /^#[0-9a-f]{6}$/i.test(form.primaryColor) ? form.primaryColor : undefined;
  const logo = /^https:\/\//.test(form.logoUrl.trim()) ? form.logoUrl.trim() : null;

  return (
    <form onSubmit={save} className="form settings-section panel-form">
      <header className="section-head">
        <p>{t('admin.branding.intro')}</p>
      </header>
      <div
        className="brand-preview"
        style={color ? ({ '--brand': color } as CSSProperties) : undefined}
        aria-label={t('admin.branding.preview')}
        role="img"
      >
        <span className="brand-preview-bar">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" />
          ) : (
            <span className="brand-preview-mark" aria-hidden />
          )}
          <strong>{form.productName || '—'}</strong>
        </span>
        <span className="btn small">{t('admin.branding.previewButton')}</span>
      </div>
      <label>
        {t('admin.branding.productName')}
        <input
          required
          maxLength={60}
          value={form.productName}
          onChange={(e) => setForm({ ...form, productName: e.target.value })}
        />
        <span className="field-help">{t('admin.branding.productNameHelp')}</span>
      </label>
      <div className="fields">
        <label>
          {t('admin.branding.primaryColor')}
          <span className="row color-field">
            <input
              type="color"
              aria-label={t('admin.branding.primaryColor')}
              value={color ?? '#000000'}
              onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
            />
            <input
              value={form.primaryColor}
              onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
            />
          </span>
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
        </label>
      </div>
      <span className="field-help">{t('admin.branding.defaultLocaleHint')}</span>
      <label>
        {t('admin.branding.logoUrl')}
        <input
          type="url"
          value={form.logoUrl}
          onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
        />
        <span className="field-help">{t('admin.branding.logoUrlHelp')}</span>
      </label>
      <div className="row">
        <button className="btn">{t('admin.branding.save')}</button>
        <span className="status-line" role="status">
          {status}
        </span>
      </div>
    </form>
  );
}
