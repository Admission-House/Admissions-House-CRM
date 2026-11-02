import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { LeadListItem, Page, Queues } from '@/models/types';

const PAGE = 30;

export const QUEUES: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'fresh', label: 'Fresh' },
  { key: 'missed', label: 'Missed' },
  { key: 'followup', label: 'Follow-up' },
  { key: 'counselled', label: 'Counselled' },
  { key: 'fee_paid', label: 'Fee paid' },
  { key: 'closed', label: 'Closed' },
];

/** The leads list: one queue at a time, a search box that waits a moment, and "load more". */
export function useLeadsViewModel() {
  const [queue, setQueue] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [extra, setExtra] = useState<{ key: string; items: LeadListItem[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 350);
    return () => clearTimeout(t);
  }, [typed]);

  const query = useMemo(() => ({ queue: queue || undefined, q: q || undefined, limit: PAGE }), [queue, q]);
  const key = JSON.stringify(query);
  const first = useApi<Page<LeadListItem>>('/leads', query);
  const queues = useApi<Queues>('/leads/queues');

  const more = extra?.key === key ? extra : null;
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const cursor = more ? more.next : (first.data?.nextCursor ?? null);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api<Page<LeadListItem>>('/leads', { query: { ...query, cursor } });
      setExtra({ key, items: [...(more?.items ?? []), ...page.items], next: page.nextCursor });
    } catch (e) {
      setMoreError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, query, key, more]);

  const refresh = () => { setExtra(null); first.reload(); queues.reload(); };
  const count = (k: string) => (k === '' ? queues.data?.total : queues.data?.queues[k]);

  return { queue, setQueue, typed, setTyped, items, hasMore: !!cursor, loadMore, loadingMore, moreError, loading: first.loading && !first.data, error: first.error, refresh, refreshing: first.loading && !!first.data, count };
}
