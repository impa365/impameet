'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { serverMessage, useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';
import { api } from '../api';
import { SmtpFields, SmtpTestLine, type SmtpView, bodyOf, draftOf } from './SmtpForm';
import { messageOf, useLoad } from './useLoad';

interface PlatformMailView {
  encryption: boolean;
  server: (SmtpView & { offerToTenants: boolean }) | null;
  legacy: boolean;
}

/** Super admin: the platform's SMTP server and whether organizations may send through it. */
export function PlatformMail() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ mail: PlatformMailView }>('/api/superadmin/mail');
  const mail = data?.mail;
  const [draft, setDraft] = useState(draftOf(null));
  const [offer, setOffer] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!mail) return;
    setDraft(draftOf(mail.server));
    setOffer(mail.server?.offerToTenants ?? true);
  }, [mail]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError('');
    setNotice(null);
    try {
      await api('/api/superadmin/mail', { method: 'PUT', body: { ...bodyOf(draft), offerToTenants: offer } });
      await reload();
      setNotice({ ok: true, text: t('mail.saved') });
    } catch (err) {
      setError(messageOf(err, t('mail.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; error?: string; to: string }>('/api/superadmin/mail/test', {
        body: {},
      });
      setNotice(
        res.ok
          ? { ok: true, text: t('mail.testOk', { to: res.to }) }
          : { ok: false, text: t('mail.testFailed', { error: serverMessage(res.error ?? '') }) },
      );
      await reload();
    } catch (err) {
      setError(messageOf(err, t('mail.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="form settings-section panel-form platform-mail" onSubmit={save} noValidate>
      <header className="section-head">
        <h3>
          <Icon name="mail" size={20} /> {t('mail.platformTitle')}
        </h3>
        <p>{t('mail.platformIntro')}</p>
      </header>
      {mail && !mail.encryption && <p className="int-empty">{t('mail.encryptionMissing')}</p>}
      {mail?.legacy && <p className="int-empty">{t('mail.legacy')}</p>}
      <SmtpFields draft={draft} onChange={setDraft} hasPassword={Boolean(mail?.server?.hasPassword)} />
      <label className="switch">
        <input type="checkbox" checked={offer} onChange={(e) => setOffer(e.target.checked)} />
        <span>
          {t('mail.offer')}
          <small>{t('mail.offerHelp')}</small>
        </span>
      </label>
      <SmtpTestLine view={mail?.server ?? null} />
      <div className="row">
        <button className="btn" disabled={busy !== null || !mail}>
          {busy === 'save' ? t('mail.saving') : t('mail.save')}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy !== null || !(mail?.server || mail?.legacy)}
          onClick={test}
        >
          <Icon name="send" size={16} />
          {busy === 'test' ? t('mail.testing') : t('mail.test')}
        </button>
        {notice && (
          <span className={notice.ok ? 'muted' : 'error'} role="status">
            {notice.text}
          </span>
        )}
      </div>
      <div className="error" role="alert">
        {error}
      </div>
    </form>
  );
}
