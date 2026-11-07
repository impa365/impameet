'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { LOCALES, LOCALE_COOKIE, LOCALE_LABEL, type Locale } from '@/i18n/config';
import { Icon } from './ui/Icon';

/** Saves the choice in a cookie and re-renders in place: no reload, a call stays connected. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = next;
    startTransition(() => router.refresh());
  }

  return (
    <label className={compact ? 'lang-switch compact' : 'lang-switch'}>
      <Icon name="language" size={20} />
      <span className="sr-only">{t('common.chooseLanguage')}</span>
      <select
        value={locale}
        onChange={(e) => choose(e.target.value as Locale)}
        disabled={pending}
        aria-label={t('common.chooseLanguage')}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {compact ? l.slice(0, 2).toUpperCase() : LOCALE_LABEL[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
