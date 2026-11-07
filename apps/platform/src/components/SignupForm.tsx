'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from './api';

function toSlug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function SignupForm({
  platformDomain,
  fixedSlug,
}: {
  platformDomain: string;
  fixedSlug: string | null;
}) {
  const t = useT();
  const [organization, setOrganization] = useState('');
  const [slug, setSlug] = useState(fixedSlug ?? '');
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { next } = await api<{ next: string }>('/api/auth/signup', {
        body: { organization, slug: fixedSlug ?? slug, name, email, password },
      });
      window.location.assign(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('shell.signup.failed'));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        {t('shell.signup.organization')}
        <input
          required
          maxLength={80}
          value={organization}
          onChange={(e) => {
            setOrganization(e.target.value);
            if (!slugTouched && !fixedSlug) setSlug(toSlug(e.target.value));
          }}
        />
      </label>
      {!fixedSlug && (
        <label>
          {t('shell.signup.address')}
          <div className="row">
            <input
              required
              maxLength={40}
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
            <span className="muted">.{platformDomain}</span>
          </div>
        </label>
      )}
      <label>
        {t('shell.signup.yourName')}
        <input
          required
          maxLength={80}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        {t('shell.signup.email')}
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        {t('shell.signup.password')}
        <input
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button className="btn" disabled={busy}>
        {t('shell.signup.submit')}
      </button>
      <div className="error" role="alert">
        {error}
      </div>
    </form>
  );
}
