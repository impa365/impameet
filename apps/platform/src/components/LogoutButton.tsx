'use client';

import { useT } from '@/i18n/client';
import { api } from './api';
import { Icon } from './ui/Icon';

export function LogoutButton() {
  const t = useT();
  return (
    <button
      className="icon-btn"
      aria-label={t('common.logout')}
      data-tip={t('common.logout')}
      data-tip-pos="below"
      onClick={async () => {
        await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
        window.location.assign('/');
      }}
    >
      <Icon name="logout" />
    </button>
  );
}
