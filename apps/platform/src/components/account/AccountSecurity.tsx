'use client';

import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { Icon, type IconName } from '../ui/Icon';
import { ApiError, api } from '../api';
import { METHOD, type Method } from '../auth/MfaStep';
import { CodeInput, RecoveryCodes, TotpSetup } from '../auth/MfaParts';
import { useLoad } from '../admin/useLoad';

interface Overview {
  requireMfa: boolean;
  encryption: boolean;
  emailAvailable: boolean;
  totp: { enabled: boolean };
  email: { enabled: boolean };
  passkeys: {
    id: string;
    name: string;
    here: boolean;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  recovery: { left: number; createdAt: string | null };
}

interface Session {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  mfaMethod: string | null;
  current: boolean;
}

/** "Chrome · Windows" from a user agent, good enough to recognise one's own devices. */
export function deviceName(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return [browser, os].filter(Boolean).join(' · ') || null;
}

const post = <T,>(body: Record<string, unknown>) => api<T>('/api/account/security', { body });

function Card({
  icon,
  title,
  status,
  children,
}: {
  icon: IconName;
  title: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section account-card">
      <header className="account-card-head">
        <span className="tile-avatar" aria-hidden>
          <Icon name={icon} size={20} />
        </span>
        <h3>{title}</h3>
        {status}
      </header>
      {children}
    </section>
  );
}

function OnOff({ on }: { on: boolean }) {
  const t = useT();
  return (
    <span className="status-line">
      <span className={on ? 'status-dot' : 'status-dot idle'} aria-hidden />
      {on ? t('security.account.enabled') : t('security.account.disabled')}
    </span>
  );
}

/** Asks for the password before something that weakens the account. */
function PasswordConfirm({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: (p: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  return (
    <form
      className="form account-reauth"
      onSubmit={(e: FormEvent) => (e.preventDefault(), onConfirm(password))}
      noValidate
    >
      <label>
        {t('security.account.passwordPrompt')}
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="row">
        <button className="btn danger" disabled={busy || !password}>
          {t('security.account.confirm')}
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>
          {t('security.setup.cancel')}
        </button>
      </div>
    </form>
  );
}

type Pending =
  | { kind: 'totp-disable' }
  | { kind: 'email-disable' }
  | { kind: 'recovery-regenerate' }
  | { kind: 'passkey-remove'; id: string };

/** The signed-in user's own security: verification methods, recovery codes and sessions. */
export function AccountSecurity({ setupRequired }: { setupRequired: boolean }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { data, error, setError, reload } = useLoad<{ security: Overview; sessions: Session[] }>(
    '/api/account/security',
  );
  const s = data?.security;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [email, setEmail] = useState<{ token: string; to: string } | null>(null);
  const [emailCode, setEmailCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [passkeyName, setPasskeyName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const when = (d: string) => new Date(d).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  const anyFactor = Boolean(s && (s.totp.enabled || s.email.enabled || s.passkeys.length > 0));

  async function act<T>(work: () => Promise<T>, then?: (r: T) => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await work();
      then?.(r);
      await reload();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('security.account.couldNotSave'));
    } finally {
      setBusy(false);
    }
  }

  const gotCodes = (r: { recoveryCodes: string[] | null }) => {
    if (r.recoveryCodes?.length) setCodes(r.recoveryCodes);
    else setNotice(t('security.account.done'));
  };

  const confirmPending = (password: string) => {
    if (!pending) return;
    const body =
      pending.kind === 'passkey-remove'
        ? { action: pending.kind, id: pending.id, password }
        : { action: pending.kind, password };
    void act(
      () => post<{ recoveryCodes?: string[] }>(body),
      (r) => {
        setPending(null);
        if (r.recoveryCodes) setCodes(r.recoveryCodes);
        else setNotice(t('security.account.done'));
      },
    );
  };

  const addPasskey = (e: FormEvent) => {
    e.preventDefault();
    void act(
      async () => {
        const { token, options } = await post<{
          token: string;
          options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        }>({ action: 'passkey-options' });
        const response = await startRegistration({ optionsJSON: options });
        return post<{ recoveryCodes: string[] | null }>({
          action: 'passkey-add',
          token,
          response,
          name: passkeyName || 'Passkey',
        });
      },
      (r) => (setAdding(false), setPasskeyName(''), gotCodes(r)),
    );
  };

  if (codes)
    return (
      <div className="settings-body">
        <section className="settings-section">
          <RecoveryCodes
            codes={codes}
            onDone={() => {
              setCodes(null);
              if (setupRequired) router.push('/dashboard');
            }}
          />
        </section>
      </div>
    );

  const reauth = (kind: Pending['kind']) =>
    pending?.kind === kind && (
      <PasswordConfirm busy={busy} onConfirm={confirmPending} onCancel={() => setPending(null)} />
    );

  return (
    <div className="settings-body account">
      {setupRequired && !anyFactor && (
        <p className="mfa-warning account-banner">
          <Icon name="shield" size={18} />
          {t('security.account.setupBanner')}
        </p>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {s && (
        <>
          <section className="settings-section account-summary">
            <header className="section-head">
              <h3>{t('security.account.mfaTitle')}</h3>
              <p>{t('security.account.mfaIntro')}</p>
            </header>
            <div className="row">
              <span className="status-line">
                <span className={anyFactor ? 'status-dot' : 'status-dot bad'} aria-hidden />
                {anyFactor ? t('security.account.on') : t('security.account.off')}
              </span>
              {s.requireMfa && <span className="badge primary">{t('security.account.required')}</span>}
            </div>
          </section>

          <Card
            icon={METHOD.passkey[1]}
            title={t('security.account.passkeysTitle')}
            status={<OnOff on={s.passkeys.length > 0} />}
          >
            <p className="muted">{t('security.account.passkeysIntro')}</p>
            {s.passkeys.length === 0 ? (
              <p className="int-empty">{t('security.account.noPasskeys')}</p>
            ) : (
              <ul className="item-list">
                {s.passkeys.map((k) => (
                  <li key={k.id} className="list-row">
                    <div className="list-row-main">
                      {renaming?.id === k.id ? (
                        <form
                          className="row"
                          onSubmit={(e) => (
                            e.preventDefault(),
                            void act(
                              () => post({ action: 'passkey-rename', id: k.id, name: renaming.name }),
                              () => setRenaming(null),
                            )
                          )}
                        >
                          <input
                            value={renaming.name}
                            maxLength={60}
                            autoFocus
                            aria-label={t('security.setup.passkeyName')}
                            onChange={(e) => setRenaming({ id: k.id, name: e.target.value })}
                          />
                          <button className="btn small" disabled={busy || !renaming.name.trim()}>
                            {t('security.account.save')}
                          </button>
                        </form>
                      ) : (
                        <strong>
                          <Icon name="fingerprint" size={16} />
                          {k.name}
                          <span className="badge">
                            {k.here ? t('security.account.here') : t('security.account.elsewhere')}
                          </span>
                          {k.backedUp && <span className="badge">{t('security.account.synced')}</span>}
                        </strong>
                      )}
                      <span className="muted">
                        {t('security.account.created', { when: when(k.createdAt) })} ·{' '}
                        {k.lastUsedAt
                          ? t('security.account.lastUsed', { when: when(k.lastUsedAt) })
                          : t('security.account.neverUsed')}
                      </span>
                      {pending?.kind === 'passkey-remove' && pending.id === k.id && (
                        <PasswordConfirm
                          busy={busy}
                          onConfirm={confirmPending}
                          onCancel={() => setPending(null)}
                        />
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn text small"
                        onClick={() => setRenaming({ id: k.id, name: k.name })}
                      >
                        <Icon name="edit" size={16} />
                        {t('security.account.rename')}
                      </button>
                      <button
                        className="btn text danger small"
                        onClick={() => setPending({ kind: 'passkey-remove', id: k.id })}
                      >
                        <Icon name="delete" size={16} />
                        {t('security.account.remove')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {adding ? (
              <form className="form account-inline" onSubmit={addPasskey} noValidate>
                <label>
                  {t('security.setup.passkeyName')}
                  <input
                    value={passkeyName}
                    maxLength={60}
                    autoFocus
                    placeholder={t('security.setup.passkeyNamePlaceholder')}
                    onChange={(e) => setPasskeyName(e.target.value)}
                  />
                </label>
                <div className="row">
                  <button className="btn" disabled={busy}>
                    <Icon name="fingerprint" size={18} />
                    {t('security.setup.passkeyCreate')}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => setAdding(false)}>
                    {t('security.setup.cancel')}
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="btn secondary account-action"
                disabled={!browserSupportsWebAuthn()}
                onClick={() => setAdding(true)}
              >
                <Icon name="add" size={18} />
                {t('security.account.addPasskey')}
              </button>
            )}
          </Card>

          <Card
            icon={METHOD.totp[1]}
            title={t('security.method.totp')}
            status={<OnOff on={s.totp.enabled} />}
          >
            <p className="muted">{t('security.method.totpHint')}</p>
            {!s.encryption && <p className="int-empty">{t('security.account.encryptionMissing')}</p>}
            {totp ? (
              <TotpSetup
                setup={totp}
                busy={busy}
                onConfirm={(code) =>
                  void act(
                    () => post<{ recoveryCodes: string[] | null }>({ action: 'totp-confirm', code }),
                    (r) => (setTotp(null), gotCodes(r)),
                  )
                }
                onCancel={() => setTotp(null)}
              />
            ) : s.totp.enabled ? (
              reauth('totp-disable') || (
                <button
                  className="btn secondary account-action"
                  onClick={() => setPending({ kind: 'totp-disable' })}
                >
                  {t('security.account.disable')}
                </button>
              )
            ) : (
              <button
                className="btn account-action"
                disabled={busy || !s.encryption}
                onClick={() =>
                  void act(() => post<{ secret: string; qr: string }>({ action: 'totp-start' }), setTotp)
                }
              >
                {t('security.account.enable')}
              </button>
            )}
          </Card>

          <Card
            icon={METHOD.email[1]}
            title={t('security.method.email')}
            status={<OnOff on={s.email.enabled} />}
          >
            <p className="muted">{t('security.method.emailHint')}</p>
            {!s.emailAvailable && !s.email.enabled && (
              <p className="int-empty">{t('security.account.emailUnavailable')}</p>
            )}
            {email ? (
              <form
                className="form account-inline"
                noValidate
                onSubmit={(e) => (
                  e.preventDefault(),
                  void act(
                    () =>
                      post<{ recoveryCodes: string[] | null }>({
                        action: 'email-confirm',
                        token: email.token,
                        code: emailCode,
                      }),
                    (r) => (setEmail(null), setEmailCode(''), gotCodes(r)),
                  )
                )}
              >
                <p className="muted">{t('security.setup.emailIntro', { email: email.to })}</p>
                <CodeInput label={t('security.login.emailLabel')} value={emailCode} onChange={setEmailCode} />
                <div className="row">
                  <button className="btn" disabled={busy || emailCode.trim().length < 6}>
                    {t('security.login.confirm')}
                  </button>
                  <button type="button" className="btn secondary" onClick={() => setEmail(null)}>
                    {t('security.setup.cancel')}
                  </button>
                </div>
              </form>
            ) : s.email.enabled ? (
              reauth('email-disable') || (
                <button
                  className="btn secondary account-action"
                  onClick={() => setPending({ kind: 'email-disable' })}
                >
                  {t('security.account.disable')}
                </button>
              )
            ) : (
              <button
                className="btn account-action"
                disabled={busy || !s.emailAvailable}
                onClick={() =>
                  void act(
                    () => post<{ token: string; email: string }>({ action: 'email-start' }),
                    (r) => setEmail({ token: r.token, to: r.email }),
                  )
                }
              >
                {t('security.account.enable')}
              </button>
            )}
          </Card>

          <Card icon={METHOD.recovery[1]} title={t('security.account.recoveryTitle')}>
            {s.recovery.left > 0 || anyFactor ? (
              <>
                <p className={s.recovery.left <= 3 ? 'mfa-warning' : 'muted'}>
                  {t('security.account.recoveryLeft', { count: s.recovery.left })}
                </p>
                {reauth('recovery-regenerate') || (
                  <button
                    className="btn secondary account-action"
                    disabled={!anyFactor}
                    onClick={() => setPending({ kind: 'recovery-regenerate' })}
                  >
                    <Icon name="refresh" size={16} />
                    {t('security.account.regenerate')}
                  </button>
                )}
              </>
            ) : (
              <p className="muted">{t('security.account.recoveryNone')}</p>
            )}
          </Card>

          <Card icon="devices" title={t('security.account.sessionsTitle')}>
            <p className="muted">{t('security.account.sessionsIntro')}</p>
            <ul className="item-list">
              {data.sessions.map((x) => (
                <li key={x.id} className="list-row">
                  <div className="list-row-main">
                    <strong>
                      <Icon name="computer" size={16} />
                      {deviceName(x.userAgent) ?? t('security.account.unknownDevice')}
                      {x.current && <span className="badge primary">{t('security.account.thisDevice')}</span>}
                    </strong>
                    <span className="muted">
                      {[
                        x.ip,
                        t('security.account.lastSeen', { when: when(x.lastSeenAt) }),
                        x.mfaMethod && METHOD[x.mfaMethod as Method]
                          ? t('security.account.verifiedWith', {
                              method: t(METHOD[x.mfaMethod as Method][0]),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {!x.current && (
                    <div className="row-actions">
                      <button
                        className="btn text danger small"
                        disabled={busy}
                        onClick={() => void act(() => post({ action: 'session-revoke', id: x.id }))}
                      >
                        {t('security.account.signOut')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {data.sessions.length > 1 && (
              <button
                className="btn secondary account-action"
                disabled={busy}
                onClick={() => void act(() => post({ action: 'session-revoke', id: 'others' }))}
              >
                <Icon name="logout" size={16} />
                {t('security.account.signOutOthers')}
              </button>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
