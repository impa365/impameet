'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

interface PlatformGoogleView {
  encryption: boolean;
  clientId: string | null;
  hasSecret: boolean;
  redirectUri: string;
}

const STEPS: MessageKey[] = [
  'storage.step1',
  'storage.step2',
  'storage.step3',
  'storage.step4',
  'storage.step5',
  'storage.step6',
  'storage.step7',
  'storage.step8',
];
const SECURITY: MessageKey[] = ['storage.security1', 'storage.security2', 'storage.security3'];

/** Super admin: the Google Cloud OAuth client organizations connect Drive (and YouTube) with. */
export function PlatformGoogle() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ google: PlatformGoogleView }>('/api/superadmin/google');
  const google = data?.google;
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (google) setClientId(google.clientId ?? '');
  }, [google]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/superadmin/google', {
        method: 'PUT',
        body: { clientId: clientId.trim(), clientSecret },
      });
      setClientSecret('');
      await reload();
      setNotice(t('storage.googleSaved'));
    } catch (err) {
      setError(messageOf(err, t('storage.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!google) return;
    await navigator.clipboard.writeText(google.redirectUri).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <form className="form settings-section panel-form platform-google" onSubmit={save} noValidate>
      <header className="section-head">
        <h3>
          <Icon name="cloud_upload" size={20} /> {t('storage.googleTitle')}
        </h3>
        <p>{t('storage.googleIntro')}</p>
      </header>
      {google && !google.encryption && <p className="int-empty">{t('storage.encryptionMissing')}</p>}
      <p className="status-line">
        <span className={google?.hasSecret ? 'status-dot' : 'status-dot idle'} aria-hidden />
        {google?.hasSecret
          ? t('storage.googleConfigured', { id: `${(google.clientId ?? '').slice(0, 12)}…` })
          : t('storage.googleMissing')}
      </p>
      <label>
        {t('storage.redirectUri')}
        <span className="row">
          <input readOnly value={google?.redirectUri ?? ''} onFocus={(e) => e.target.select()} />
          <button type="button" className="btn secondary small" onClick={() => void copy()}>
            <Icon name="content_copy" size={16} />
            {copied ? t('storage.copied') : t('storage.copy')}
          </button>
        </span>
      </label>
      <label>
        {t('storage.clientId')}
        <input
          required
          autoComplete="off"
          maxLength={200}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="123456789012-abc….apps.googleusercontent.com"
        />
      </label>
      <label>
        {t('storage.clientSecret')}
        <input
          type="password"
          autoComplete="new-password"
          maxLength={200}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={google?.hasSecret ? t('storage.keepClientSecret') : 'GOCSPX-…'}
        />
      </label>
      <div className="row">
        <button className="btn" disabled={busy || !google?.encryption}>
          {t('storage.saveGoogle')}
        </button>
        {notice && (
          <span className="muted" role="status">
            {notice}
          </span>
        )}
      </div>
      <div className="error" role="alert">
        {error}
      </div>
      <details className="tutorial">
        <summary>{t('storage.tutorialTitle')}</summary>
        <ol>
          {STEPS.map((step) => (
            <li key={step}>{t(step)}</li>
          ))}
        </ol>
        <h4>{t('storage.securityTitle')}</h4>
        <ul>
          {SECURITY.map((tip) => (
            <li key={tip}>{t(tip)}</li>
          ))}
        </ul>
      </details>
    </form>
  );
}
