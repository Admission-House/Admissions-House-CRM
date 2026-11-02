import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { api } from '@/core/api';
import { fromNow } from '@/core/format';
import { color } from '@/core/theme';
import { errorText, useApi } from '@/core/use-api';
import { Button, Card, Chips, Empty, Muted, Notice, Screen, Spinner } from '@/core/ui';
import { describeNotification } from '@/models/notification-text';
import type { AppNotification, Page } from '@/models/types';

export default function Notifications() {
  const router = useRouter();
  const [view, setView] = useState<'all' | 'unread'>('all');
  const query = useMemo(() => ({ limit: 100, unreadOnly: view === 'unread' ? 'true' : undefined }), [view]);
  const list = useApi<Page<AppNotification>>('/notifications', query);
  const count = useApi<{ unread: number }>('/notifications/unread-count');
  const [error, setError] = useState<string | null>(null);

  async function markAll() {
    setError(null);
    try { await api('/notifications/read', { method: 'POST', body: { all: true } }); list.reload(); count.reload(); } catch (e) { setError(errorText(e)); }
  }

  async function open(n: AppNotification) {
    if (!n.readAt) await api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => undefined);
    const d = describeNotification(n);
    list.reload();
    count.reload();
    if (d.leadId) router.push(`/lead/${d.leadId}`);
    else if (d.screen) router.push(d.screen);
  }

  const items = list.data?.items ?? [];
  return (
    <Screen onRefresh={() => { list.reload(); count.reload(); }} refreshing={list.loading && !!list.data}>
      <Chips options={[{ key: 'all', label: 'All' }, { key: 'unread', label: `Unread${count.data ? ` ${count.data.unread}` : ''}` }]} value={view} onChange={setView} />
      {!!count.data?.unread && <Button title="Mark all as read" variant="secondary" onPress={() => void markAll()} />}
      {error && <Notice tone="bad">{error}</Notice>}
      {list.error && <Notice tone="bad">{list.error.message}</Notice>}
      {list.loading && !list.data ? <Spinner /> : items.length === 0 ? <Empty title="You are all caught up" /> : (
        <Card style={{ paddingVertical: 4 }}>
          {items.map((n) => {
            const d = describeNotification(n);
            return (
              <Pressable key={n.id} accessibilityRole="button" onPress={() => void open(n)} style={{ flexDirection: 'row', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.line }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: n.readAt ? 'transparent' : color.brand600 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: color.ink, fontWeight: n.readAt ? '400' : '700' }}>{d.title}</Text>
                  {!!d.detail && <Muted>{d.detail}</Muted>}
                  <Muted>{fromNow(n.createdAt)}</Muted>
                </View>
              </Pressable>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}
