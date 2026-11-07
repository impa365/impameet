'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/client';
import { ApiError, api } from '../api';

/** Loads a JSON endpoint, optionally refreshing on an interval. */
export function useLoad<T>(path: string, refreshMs?: number) {
  const t = useT();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setData(await api<T>(path));
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.couldNotLoad'));
    }
  }, [path, t]);

  useEffect(() => {
    void reload();
    if (!refreshMs) return;
    const timer = setInterval(reload, refreshMs);
    return () => clearInterval(timer);
  }, [reload, refreshMs]);

  return { data, error, setError, reload };
}

export function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
