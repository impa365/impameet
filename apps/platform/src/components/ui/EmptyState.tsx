'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { Icon, type IconName } from './Icon';

/** A page or list with nothing in it yet: what goes here, and how to get the first one. */
export function EmptyState(props: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden>
        <Icon name={props.icon} size={36} />
      </span>
      <h2>{props.title}</h2>
      <p>{props.children}</p>
      {props.action}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="loading-state" role="status">
      <span className="loading-bar" aria-hidden />
      <span className="sr-only">{label ?? t('common.loading')}</span>
    </div>
  );
}
