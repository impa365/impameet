'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { roomFromInput } from '@/lib/room-code';
import { ApiError, api } from './api';
import { Icon } from './ui/Icon';

export function StartMeeting({ signedIn }: { signedIn: boolean }) {
  const t = useT();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    if (!signedIn) {
      router.push('/login');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { room } = await api<{ room: { slug: string } }>('/api/rooms', {
        body: { name: t('shell.home.defaultMeetingName') },
      });
      router.push(`/r/${room.slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('shell.home.createFailed'));
      setBusy(false);
    }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    const slug = roomFromInput(code);
    if (!slug) {
      setError(t('shell.home.invalidCode'));
      return;
    }
    router.push(`/r/${slug}`);
  }

  return (
    <div className="start">
      <div className="start-row">
        <button className="btn large" onClick={() => void start()} disabled={busy}>
          <Icon name="video_call" size={22} />
          {signedIn ? t('shell.home.newMeeting') : t('shell.home.signInToCreate')}
        </button>
        <form className="start-join" onSubmit={join}>
          <label className="field-icon">
            <Icon name="link" size={20} />
            <input
              aria-label={t('shell.home.codeLabel')}
              placeholder={t('shell.home.codePlaceholder')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className="btn text" disabled={!code.trim()}>
            {t('shell.home.join')}
          </button>
        </form>
      </div>
      <div className="error" role="alert">
        {error}
      </div>
    </div>
  );
}
