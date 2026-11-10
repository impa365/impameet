'use client';

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon, type IconName } from '../ui/Icon';
import { ApiError, api } from '../api';
import { CodeInput, RecoveryCodes, TotpSetup } from './MfaParts';

export type Method = 'passkey' | 'totp' | 'email' | 'recovery';

export type MfaNext =
  | { kind: 'verify'; token: string; methods: Method[]; email: string; passkeysElsewhere: boolean }
  | { kind: 'enroll'; token: string; methods: Exclude<Method, 'recovery'>[] };

export interface Signed {
  recoveryCodes?: string[];
  recoveryLeft?: number;
}

export const METHOD: Record<Method, [MessageKey, IconName]> = {
  passkey: ['security.method.passkey', 'fingerprint'],
  totp: ['security.method.totp', 'password'],
  email: ['security.method.email', 'mail'],
  recovery: ['security.method.recovery', 'key'],
};
const HINT: Record<Exclude<Method, 'recovery'>, MessageKey> = {
  passkey: 'security.method.passkeyHint',
  totp: 'security.method.totpHint',
  email: 'security.method.emailHint',
};

const mfa = <T,>(body: Record<string, unknown>) => api<T>('/api/auth/mfa', { body });

/** The step after the password: confirming with a second factor, or setting one up. */
export function MfaStep({
  next,
  onSigned,
  onBack,
}: {
  next: MfaNext;
  onSigned: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const finish = (res: Signed) => {
    if (res.recoveryCodes?.length) setCodes(res.recoveryCodes);
    else if (typeof res.recoveryLeft === 'number') setLeft(res.recoveryLeft);
    else onSigned();
  };
  if (codes) return <RecoveryCodes codes={codes} onDone={onSigned} />;
  if (left !== null)
    return (
      <div className="form">
        <p className="mfa-warning">
          <Icon name="warning" size={18} />
          {t('security.login.recoveryLeft', { count: left })}
        </p>
        <button className="btn" onClick={onSigned}>
          {t('security.login.continue')}
        </button>
      </div>
    );
  return next.kind === 'verify' ? (
    <Verify next={next} onSigned={finish} onBack={onBack} />
  ) : (
    <Enroll next={next} onSigned={finish} onBack={onBack} />
  );
}

function errorText(err: unknown, fallback: string) {
  if (err instanceof ApiError) return err.message;
  return fallback;
}

function Verify({
  next,
  onSigned,
  onBack,
}: {
  next: Extract<MfaNext, { kind: 'verify' }>;
  onSigned: (r: Signed) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [method, setMethod] = useState<Method | null>(next.methods[0] ?? null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');

  async function run<T>(work: () => Promise<T>, then: (r: T) => void, fallback = t('security.login.failed')) {
    setBusy(true);
    setError('');
    try {
      then(await work());
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const passkey = () =>
    run(
      async () => {
        const { options } = await mfa<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>({
          action: 'passkey-options',
          token: next.token,
        });
        const response = await startAuthentication({ optionsJSON: options });
        return mfa<Signed>({ action: 'verify-passkey', token: next.token, response });
      },
      onSigned,
      t('security.login.passkeyFailed'),
    );

  const sendEmail = () =>
    run(
      () => mfa<{ email: string }>({ action: 'send-email', token: next.token }),
      (r) => setSentTo(r.email),
    );

  const verifyCode = (e: FormEvent) => {
    e.preventDefault();
    if (!method || method === 'passkey') return;
    void run(() => mfa<Signed>({ action: 'verify-code', token: next.token, method, code }), onSigned);
  };

  return (
    <div className="mfa-step">
      <header>
        <span className="mfa-shield" aria-hidden>
          <Icon name="verified_user" size={26} />
        </span>
        <h3>{t('security.login.verifyTitle')}</h3>
        <p className="muted">{t('security.login.verifyIntro')}</p>
      </header>
      {next.passkeysElsewhere && <p className="mfa-warning">{t('security.login.passkeysElsewhere')}</p>}
      {method === 'passkey' && (
        <div className="form">
          <button className="btn mfa-big" disabled={busy || !browserSupportsWebAuthn()} onClick={passkey}>
            <Icon name="fingerprint" size={22} />
            {t('security.login.passkeyButton')}
          </button>
          {!browserSupportsWebAuthn() && <p className="muted">{t('security.login.passkeyUnsupported')}</p>}
        </div>
      )}
      {method && method !== 'passkey' && (
        <form className="form" onSubmit={verifyCode} noValidate>
          {method === 'email' && !sentTo ? (
            <button type="button" className="btn" disabled={busy} onClick={sendEmail}>
              <Icon name="send" size={18} />
              {t('security.login.emailSend', { email: next.email })}
            </button>
          ) : (
            <>
              {method === 'email' && (
                <p className="muted">{t('security.login.emailSent', { email: sentTo })}</p>
              )}
              <CodeInput
                key={method}
                label={t(
                  method === 'totp'
                    ? 'security.login.totpLabel'
                    : method === 'email'
                      ? 'security.login.emailLabel'
                      : 'security.login.recoveryLabel',
                )}
                value={code}
                onChange={setCode}
                recovery={method === 'recovery'}
              />
              {method === 'recovery' && (
                <span className="field-help">{t('security.login.recoveryHint')}</span>
              )}
              <div className="row">
                <button className="btn" disabled={busy || code.trim().length < 6}>
                  {busy ? t('security.login.confirming') : t('security.login.confirm')}
                </button>
                {method === 'email' && (
                  <button type="button" className="btn text small" disabled={busy} onClick={sendEmail}>
                    {t('security.login.emailResend')}
                  </button>
                )}
              </div>
            </>
          )}
        </form>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      {next.methods.length > 1 && (
        <div className="mfa-others">
          <span className="muted">{t('security.login.otherMethods')}</span>
          <div className="chips">
            {next.methods
              .filter((m) => m !== method)
              .map((m) => (
                <button
                  key={m}
                  type="button"
                  className="chip add"
                  onClick={() => (setMethod(m), setCode(''), setError(''))}
                >
                  <Icon name={METHOD[m][1]} size={14} />
                  {t(METHOD[m][0])}
                </button>
              ))}
          </div>
        </div>
      )}
      <button type="button" className="btn text small" onClick={onBack}>
        <Icon name="arrow_back" size={16} />
        {t('security.login.back')}
      </button>
    </div>
  );
}

function Enroll({
  next,
  onSigned,
  onBack,
}: {
  next: Extract<MfaNext, { kind: 'enroll' }>;
  onSigned: (r: Signed) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [method, setMethod] = useState<Exclude<Method, 'recovery'> | null>(null);
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run<T>(work: () => Promise<T>, then: (r: T) => void) {
    setBusy(true);
    setError('');
    try {
      then(await work());
    } catch (err) {
      setError(errorText(err, t('security.login.failed')));
    } finally {
      setBusy(false);
    }
  }

  const choose = (m: Exclude<Method, 'recovery'>) => {
    setMethod(m);
    setError('');
    if (m === 'totp')
      void run(
        () => mfa<{ secret: string; qr: string }>({ action: 'enroll-totp', token: next.token }),
        setTotp,
      );
    if (m === 'email')
      void run(
        () => mfa<{ email: string }>({ action: 'enroll-email', token: next.token }),
        (r) => setEmailTo(r.email),
      );
  };

  const passkey = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { options } = await mfa<{ options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>({
        action: 'enroll-passkey-options',
        token: next.token,
      });
      const response = await startRegistration({ optionsJSON: options });
      return mfa<Signed>({ action: 'enroll-passkey', token: next.token, response, name: name || 'Passkey' });
    }, onSigned);
  };

  return (
    <div className="mfa-step">
      <header>
        <span className="mfa-shield" aria-hidden>
          <Icon name="verified_user" size={26} />
        </span>
        <h3>{t('security.login.enrollTitle')}</h3>
        <p className="muted">{t('security.login.enrollIntro')}</p>
      </header>
      {!method && (
        <div className="mfa-choices">
          {next.methods.map((m) => (
            <button key={m} type="button" className="kind-option" onClick={() => choose(m)}>
              <span className="int-icon tile-avatar" aria-hidden>
                <Icon name={METHOD[m][1]} size={20} />
              </span>
              <span>
                <strong>{t(METHOD[m][0])}</strong>
                <small>{t(HINT[m])}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {method === 'totp' && totp && (
        <TotpSetup
          setup={totp}
          busy={busy}
          onConfirm={(c) =>
            void run(
              () => mfa<Signed>({ action: 'enroll-totp-confirm', token: next.token, code: c }),
              onSigned,
            )
          }
          onCancel={() => setMethod(null)}
        />
      )}
      {method === 'passkey' && (
        <form className="form" onSubmit={passkey} noValidate>
          <label>
            {t('security.setup.passkeyName')}
            <input
              value={name}
              maxLength={60}
              placeholder={t('security.setup.passkeyNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="btn" disabled={busy || !browserSupportsWebAuthn()}>
              <Icon name="fingerprint" size={18} />
              {t('security.setup.passkeyCreate')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setMethod(null)}>
              {t('security.setup.cancel')}
            </button>
          </div>
        </form>
      )}
      {method === 'email' && emailTo && (
        <form
          className="form"
          noValidate
          onSubmit={(e) => (
            e.preventDefault(),
            void run(() => mfa<Signed>({ action: 'enroll-email-confirm', token: next.token, code }), onSigned)
          )}
        >
          <p className="muted">{t('security.setup.emailIntro', { email: emailTo })}</p>
          <CodeInput label={t('security.login.emailLabel')} value={code} onChange={setCode} />
          <div className="row">
            <button className="btn" disabled={busy || code.trim().length < 6}>
              {busy ? t('security.login.confirming') : t('security.login.confirm')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setMethod(null)}>
              {t('security.setup.cancel')}
            </button>
          </div>
        </form>
      )}
      <div className="error" role="alert">
        {error}
      </div>
      <button type="button" className="btn text small" onClick={onBack}>
        <Icon name="arrow_back" size={16} />
        {t('security.login.back')}
      </button>
    </div>
  );
}
