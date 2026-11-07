'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { THEME_COOKIE, type Theme } from '@/lib/theme';
import { Icon } from './ui/Icon';

function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Switches the panel between light and dark; the call itself is always dark, as in Meet. */
export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(currentTheme()), []);

  function toggle() {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  }

  const label = theme === 'light' ? t('common.themeToDark') : t('common.themeToLight');
  return (
    <button className="icon-btn" onClick={toggle} aria-label={label} data-tip={label} data-tip-pos="below">
      {theme && <Icon name={theme === 'light' ? 'dark_mode' : 'light_mode'} />}
    </button>
  );
}
