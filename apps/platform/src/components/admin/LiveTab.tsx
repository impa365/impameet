'use client';

import Link from 'next/link';
import { useT } from '@/i18n/client';
import { EmptyState, Loading } from '../ui/EmptyState';
import { useLoad } from './useLoad';

interface LiveRoom {
  slug: string;
  name: string;
  participants: { name: string; role: string; isAgent: boolean; handRaised: boolean }[];
}

export function LiveTab() {
  const t = useT();
  const { data, error } = useLoad<{ rooms: LiveRoom[] }>('/api/admin/live', 5000);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <Loading />;
  if (data.rooms.length === 0) {
    return (
      <EmptyState icon="sensors" title={t('admin.live.emptyTitle')}>
        {t('admin.live.emptyBody')}
      </EmptyState>
    );
  }
  return (
    <ul className="rooms">
      {data.rooms.map((r) => (
        <li key={r.slug}>
          <div>
            <strong>{r.name}</strong>
            <span className="badge">{t('admin.live.online', { n: r.participants.length })}</span>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {r.participants
                .map((p) => {
                  const tag = p.isAgent
                    ? ` ${t('admin.live.ai')}`
                    : p.role === 'moderator'
                      ? ` ${t('admin.live.moderator')}`
                      : '';
                  return `${p.handRaised ? '✋ ' : ''}${p.name}${tag}`;
                })
                .join(', ')}
            </div>
          </div>
          <Link className="btn small" href={`/r/${r.slug}`}>
            {t('admin.live.enter')}
          </Link>
        </li>
      ))}
    </ul>
  );
}
