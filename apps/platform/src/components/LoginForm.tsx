'use client';

import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from './api';
import { type MfaNext, MfaStep } from './auth/MfaStep';
import { Icon } from './ui/Icon';

export function LoginForm({ initialEmail }: { initialEmail: string }) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [next, setNext] = useState<MfaNext | null>(null);
  const [passkeys, setPasskeys] = useState(false);

  useEffect(() => setPasskeys(browserSupportsWebAuthn()), []);

  const signed = () => {
    router.replace('/dashboard');
    router.refresh();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ mfa?: MfaNext }>('/api/auth/login', { body: { email, password } });
      if (res.mfa) {
        setNext(res.mfa);
        setPassword('');
        setBusy(false);
      } else signed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('shell.login.failed'));
      setBusy(false);
    }
  }

  async function withPasskey() {
    setBusy(true);
    setError('');
    try {
      const { token, options } = await api<{
        token: string;
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
      }>('/api/auth/passkey', { body: { action: 'options' } });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/api/auth/passkey', { body: { action: 'verify', token, response } });
      signed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('security.login.passkeyFailed'));
      setBusy(false);
    }
  }

  if (next) return <MfaStep next={next} onSigned={signed} onBack={() => setNext(null)} />;

  return (
    <form onSubmit={submit} className="form">
      <label>
        {t('shell.login.email')}
        <input
          type="email"
          autoComplete="username webauthn"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        {t('shell.login.password')}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button className="btn" disabled={busy}>
        {t('shell.login.submit')}
      </button>
      {passkeys && (
        <>
          <div className="login-or">
            <span>{t('security.login.or')}</span>
          </div>
          <button type="button" className="btn secondary" disabled={busy} onClick={withPasskey}>
            <Icon name="fingerprint" size={18} />
            {t('security.login.withPasskey')}
          </button>
        </>
      )}
      <div className="error" role="alert">
        {error}
      </div>
    </form>
  );
}
