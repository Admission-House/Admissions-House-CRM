import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { fmtDateTime, fmtPhone } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Badge, Button, Card, Chips, Empty, Muted, Notice, Screen, Spinner } from '@/core/ui';
import { CALL_FILTERS, OUTCOME, callLength, useCallsViewModel } from '@/viewmodels/calls';

export default function Calls() {
  const vm = useCallsViewModel();
  const { can } = useSession();
  const router = useRouter();
  const [notice, setNotice] = useState('');
  const items = vm.list.data?.items ?? [];

  return (
    <Screen onRefresh={vm.list.reload} refreshing={vm.list.loading && !!vm.list.data}>
      <Chips options={CALL_FILTERS} value={vm.filter} onChange={vm.setFilter} />
      {notice !== '' && <Notice tone="ok">{notice}</Notice>}
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      {vm.list.error && <Notice tone="bad">{vm.list.error.message}</Notice>}
      {vm.list.loading && !vm.list.data ? <Spinner /> : items.length === 0 ? <Empty title="No calls" hint="Calls you make or receive will show here." /> : items.map((c) => {
        const o = OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const };
        const incoming = c.direction === 'incoming';
        return (
          <Card key={c.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name={incoming ? 'arrow-down-circle' : 'arrow-up-circle'} size={22} color={incoming ? color.info : color.ok} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: color.ink, fontSize: 15 }} onPress={c.lead ? () => router.push(`/lead/${c.lead!.id}`) : undefined}>{c.lead?.name ?? 'Not a lead'}</Text>
                <Muted>{fmtPhone(c.number)}</Muted>
              </View>
              <Badge tone={o.tone}>{o.label}</Badge>
            </View>
            <Muted>{fmtDateTime(c.startedAt)} · {incoming ? 'Incoming' : 'Outgoing'} · {callLength(c.durationSec)}</Muted>
            {c.user && <Muted>By {c.user.name}</Muted>}
            {!!c.remark && <Text style={{ color: color.ink }}>{c.remark}</Text>}
            {c.outcome === 'connected' && !c.wrappedUp && c.lead && <Muted>After-call form pending. Open the lead to update its status.</Muted>}
            {c.recording === 'pending' && <Muted>Recording on its way</Muted>}
            {c.lead && can('call.place') && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <View style={{ flex: 1 }}><Button title="Call back" icon="call" onPress={() => void vm.callBack(c.lead!.id).then(setNotice)} /></View>
                <View style={{ flex: 1 }}><Button title="Open lead" variant="secondary" onPress={() => router.push(`/lead/${c.lead!.id}`)} /></View>
              </View>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}
