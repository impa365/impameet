'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from './api';

export function LoginForm({ initialEmail }: { initialEmail: string }) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { body: { email, password } });
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('shell.login.failed'));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        {t('shell.login.email')}
        <input
          type="email"
          autoComplete="email"
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
      <div className="error" role="alert">
        {error}
      </div>
    </form>
  );
}
