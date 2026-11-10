'use client';

import { useLocale, useT } from '@/i18n/client';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpView {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface SmtpDraft {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

export const draftOf = (v: SmtpView | null): SmtpDraft => ({
  host: v?.host ?? '',
  port: v?.port ?? 587,
  security: v?.security ?? 'starttls',
  username: v?.username ?? '',
  password: '',
  fromEmail: v?.fromEmail ?? '',
  fromName: v?.fromName ?? '',
  replyTo: v?.replyTo ?? '',
});

/** What the API expects: the password only when typed, so the saved one stays otherwise. */
export const bodyOf = (d: SmtpDraft) => ({
  host: d.host,
  port: d.port,
  security: d.security,
  username: d.username,
  ...(d.password ? { password: d.password } : {}),
  fromEmail: d.fromEmail,
  fromName: d.fromName,
  replyTo: d.replyTo.trim() || null,
});

/** Well-known servers: they fill in the address only, never credentials. */
const PRESETS: { name: string; host: string; port: number; security: SmtpSecurity }[] = [
  { name: 'Google', host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { name: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls' },
  { name: 'Amazon SES', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, security: 'starttls' },
  { name: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'starttls' },
  { name: 'Mailgun', host: 'smtp.mailgun.org', port: 587, security: 'starttls' },
  { name: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
  { name: 'Zoho', host: 'smtp.zoho.com', port: 465, security: 'tls' },
  { name: 'Hostinger', host: 'smtp.hostinger.com', port: 465, security: 'tls' },
];

export function SmtpFields({
  draft,
  onChange,
  hasPassword,
}: {
  draft: SmtpDraft;
  onChange: (d: SmtpDraft) => void;
  hasPassword: boolean;
}) {
  const t = useT();
  const set = <K extends keyof SmtpDraft>(k: K, v: SmtpDraft[K]) => onChange({ ...draft, [k]: v });
  return (
    <>
      <h4>{t('mail.server')}</h4>
      <div className="preset-grid" role="group" aria-label={t('mail.provider')}>
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={draft.host === p.host ? 'preset active' : 'preset'}
            aria-pressed={draft.host === p.host}
            onClick={() => onChange({ ...draft, host: p.host, port: p.port, security: p.security })}
          >
            {p.name}
          </button>
        ))}
      </div>
      <span className="field-help">{t('mail.providerHint')}</span>
      <div className="fields smtp-server">
        <label>
          {t('mail.host')}
          <input
            value={draft.host}
            maxLength={253}
            autoComplete="off"
            placeholder="smtp.suaempresa.com"
            onChange={(e) => set('host', e.target.value)}
          />
        </label>
        <label>
          {t('mail.port')}
          <input
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            onChange={(e) => set('port', Number(e.target.value))}
          />
        </label>
        <label>
          {t('mail.security')}
          <select value={draft.security} onChange={(e) => set('security', e.target.value as SmtpSecurity)}>
            <option value="starttls">{t('mail.securityStarttls')}</option>
            <option value="tls">{t('mail.securityTls')}</option>
            <option value="none">{t('mail.securityNone')}</option>
          </select>
        </label>
      </div>
      <div className="fields">
        <label>
          {t('mail.username')}
          <input
            value={draft.username}
            maxLength={254}
            autoComplete="off"
            onChange={(e) => set('username', e.target.value)}
          />
        </label>
        <label>
          {t('mail.password')}
          <input
            type="password"
            value={draft.password}
            maxLength={500}
            autoComplete="new-password"
            placeholder={hasPassword ? t('mail.passwordKeep') : ''}
            onChange={(e) => set('password', e.target.value)}
          />
          <span className="field-help">{t('mail.passwordHelp')}</span>
        </label>
      </div>
      <h4>{t('mail.sender')}</h4>
      <div className="fields">
        <label>
          {t('mail.fromEmail')}
          <input
            type="email"
            value={draft.fromEmail}
            maxLength={254}
            placeholder="reunioes@suaempresa.com"
            onChange={(e) => set('fromEmail', e.target.value)}
          />
        </label>
        <label>
          {t('mail.fromName')}
          <input value={draft.fromName} maxLength={80} onChange={(e) => set('fromName', e.target.value)} />
          <span className="field-help">{t('mail.fromNameHelp')}</span>
        </label>
      </div>
      <label>
        {t('mail.replyTo')}
        <input
          type="email"
          value={draft.replyTo}
          maxLength={254}
          onChange={(e) => set('replyTo', e.target.value)}
        />
      </label>
    </>
  );
}

/** The last test of a saved server, in one line. */
export function SmtpTestLine({ view }: { view: SmtpView | null }) {
  const t = useT();
  const locale = useLocale();
  if (!view) return null;
  const when = view.lastTestAt
    ? new Date(view.lastTestAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
    : '';
  return (
    <span className="status-line">
      <span
        className={
          view.lastTestOk === true
            ? 'status-dot'
            : view.lastTestOk === false
              ? 'status-dot bad'
              : 'status-dot idle'
        }
        aria-hidden
      />
      {view.lastTestOk === true
        ? t('mail.lastOk', { when })
        : view.lastTestOk === false
          ? t('mail.lastFailed', { when, error: view.lastTestError ?? '' })
          : t('mail.untested')}
    </span>
  );
}
