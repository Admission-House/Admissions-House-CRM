'use client';

import { CheckCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, Card, Empty, Notice, PageHeader, Spinner, Tabs, cx } from '@/components/ui';
import { describeNotification, type Notification } from '@/components/shell/notifications';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime, fromNow } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function NotificationsPage() {
  const router = useRouter();
  const [view, setView] = useState<'all' | 'unread'>('all');
  const list = useApi<Page<Notification>>('/notifications', useMemo(() => ({ limit: 100, unreadOnly: view === 'unread' ? 'true' : undefined }), [view]));
  const count = useApi<{ unread: number }>('/notifications/unread-count');
  const [error, setError] = useState<string | null>(null);

  async function markAll() {
    setError(null);
    try {
      await api('/notifications/read', { method: 'POST', body: { all: true } });
      list.reload();
      count.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    }
  }

  async function open(n: Notification) {
    const { href } = describeNotification(n);
    if (!n.readAt) await api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => undefined);
    if (href) router.push(href);
    else { list.reload(); count.reload(); }
  }

  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Notifications" subtitle="Assignments, follow-ups, imports and alerts" actions={(count.data?.unread ?? 0) > 0 ? <Button variant="secondary" onClick={() => void markAll()}><CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read</Button> : undefined} />
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      <Card className="overflow-hidden">
        <Tabs tabs={[{ key: 'all' as const, label: 'All' }, { key: 'unread' as const, label: 'Unread', count: count.data?.unread }]} value={view} onChange={setView} label="Notifications" />
        {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : list.loading && !list.data ? <Spinner /> : items.length === 0 ? <Empty title={view === 'unread' ? 'Nothing unread' : 'No notifications yet'}>You are all caught up.</Empty> : (
          <ul className="divide-y divide-line">
            {items.map((n) => {
              const t = describeNotification(n);
              return (
                <li key={n.id}>
                  <button onClick={() => void open(n)} className={cx('flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-head', !n.readAt && 'bg-mint-50')}>
                    <span className={cx('mt-2 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-teal-600')} aria-hidden />
                    <span className="min-w-0 flex-1"><span className="block text-[15px] font-medium text-ink">{t.title}</span>{t.detail && <span className="block text-sm text-muted">{t.detail}</span>}</span>
                    <span className="shrink-0 text-right text-xs text-subtle" title={fmtDateTime(n.createdAt)}>{fromNow(n.createdAt)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
