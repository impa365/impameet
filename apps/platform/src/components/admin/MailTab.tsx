'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { serverMessage, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon, type IconName } from '../ui/Icon';
import { api } from '../api';
import { SmtpFields, SmtpTestLine, type SmtpView, bodyOf, draftOf } from './SmtpForm';
import { messageOf, useLoad } from './useLoad';

type Mode = 'platform' | 'custom' | 'off';

interface MailView {
  encryption: boolean;
  mode: Mode;
  custom: SmtpView | null;
  platform: { available: boolean; from: string | null };
}

const MODES: [Mode, MessageKey, MessageKey, IconName][] = [
  ['platform', 'mail.modePlatform', 'mail.modePlatformHint', 'hub'],
  ['custom', 'mail.modeCustom', 'mail.modeCustomHint', 'mail'],
  ['off', 'mail.modeOff', 'mail.modeOffHint', 'block'],
];

/** How the organization sends e-mail: the platform's server, its own SMTP, or not at all. */
export function MailTab() {
  const t = useT();
  const { data, error, setError, reload } = useLoad<{ mail: MailView }>('/api/admin/mail');
  const mail = data?.mail;
  const [mode, setMode] = useState<Mode>('platform');
  const [draft, setDraft] = useState(draftOf(null));
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!mail) return;
    setMode(mail.mode);
    setDraft(draftOf(mail.custom));
  }, [mail]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError('');
    setNotice(null);
    try {
      await api('/api/admin/mail', {
        method: 'PUT',
        body: mode === 'custom' ? { mode, ...bodyOf(draft) } : { mode },
      });
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
    setError('');
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; error?: string; to: string }>('/api/admin/mail/test', {
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

  const saved = mail?.mode === mode && (mode !== 'custom' || Boolean(mail?.custom));
  return (
    <form className="form settings-form mail-tab" onSubmit={save} noValidate>
      <div className="page-head">
        <p>{t('mail.intro')}</p>
      </div>
      {mail && !mail.encryption && <p className="int-empty">{t('mail.encryptionMissing')}</p>}
      <section className="settings-section">
        <header className="section-head">
          <h3>{t('mail.how')}</h3>
          <p>{t('mail.uses')}</p>
        </header>
        <div className="kind-chooser" role="radiogroup" aria-label={t('mail.how')}>
          {MODES.map(([id, label, hint, icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? 'kind-option selected' : 'kind-option'}
              onClick={() => (setMode(id), setNotice(null))}
            >
              <span className="int-icon tile-avatar" aria-hidden>
                <Icon name={icon} size={20} />
              </span>
              <span>
                <strong>{t(label)}</strong>
                <small>
                  {id === 'platform' && mail
                    ? mail.platform.available
                      ? `${t(hint)} ${mail.platform.from ? t('mail.platformFrom', { from: mail.platform.from }) : ''}`
                      : t('mail.platformUnavailable')
                    : t(hint)}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
      {mode === 'custom' && (
        <section className="settings-section">
          <SmtpFields draft={draft} onChange={setDraft} hasPassword={Boolean(mail?.custom?.hasPassword)} />
          {mail?.mode === 'custom' && <SmtpTestLine view={mail.custom} />}
        </section>
      )}
      <div className="save-bar">
        <button className="btn" disabled={busy !== null || !mail}>
          {busy === 'save' ? t('mail.saving') : t('mail.save')}
        </button>
        {mode !== 'off' && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null || !saved || (mode === 'platform' && !mail?.platform.available)}
            onClick={test}
          >
            <Icon name="send" size={16} />
            {busy === 'test' ? t('mail.testing') : t('mail.test')}
          </button>
        )}
        {notice && (
          <span className={notice.ok ? 'muted' : 'error'} role="status">
            {notice.text}
          </span>
        )}
        <div className="error" role="alert">
          {error}
        </div>
      </div>
    </form>
  );
}
