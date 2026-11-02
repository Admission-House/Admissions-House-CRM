import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { fmtDateTime, fmtPhone, fromNow } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Button, Card, Chips, Empty, Muted, Notice, Screen, Spinner } from '@/core/ui';
import { BUCKETS, useFollowUpsViewModel } from '@/viewmodels/followups';

export default function FollowUps() {
  const vm = useFollowUpsViewModel();
  const { can } = useSession();
  const router = useRouter();
  const [notice, setNotice] = useState('');
  const counts = vm.summary.data;
  const items = vm.list.data?.items ?? [];

  return (
    <Screen onRefresh={vm.refresh} refreshing={vm.list.loading && !!vm.list.data}>
      <Chips
        options={BUCKETS.map((b) => ({ key: b.key, label: `${b.label}${b.key !== 'done' && counts ? ` ${counts[b.key]}` : ''}` }))}
        value={vm.bucket}
        onChange={vm.setBucket}
      />
      {notice !== '' && <Notice tone="ok">{notice}</Notice>}
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      {vm.list.error && <Notice tone="bad">{vm.list.error.message}</Notice>}
      {vm.list.loading && !vm.list.data ? <Spinner /> : items.length === 0 ? <Empty title="Nothing here" hint="No follow-ups in this list." /> : items.map((f) => {
        const late = !f.doneAt && new Date(f.dueAt) < new Date();
        return (
          <Card key={f.id}>
            <Text style={{ fontWeight: '700', color: color.ink, fontSize: 15 }} onPress={() => router.push(`/lead/${f.lead.id}`)}>{f.lead.name}</Text>
            <Muted>{fmtPhone(f.lead.phone)} · {f.lead.status}</Muted>
            <Text style={{ color: late ? color.bad : color.ink, fontWeight: '600' }}>{fmtDateTime(f.dueAt)} · {fromNow(f.dueAt)}</Text>
            {!!f.note && <Muted>{f.note}</Muted>}
            {!f.doneAt && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                {can('call.place') && f.lead.isOpen && <View style={{ flex: 1 }}><Button title="Call" icon="call" onPress={() => void vm.call(f.lead.id).then(setNotice)} /></View>}
                <View style={{ flex: 1 }}><Button title="WhatsApp" variant="secondary" onPress={() => void Linking.openURL(`https://wa.me/${f.lead.phone.replace(/\D/g, '')}`)} /></View>
                {can('followup.manage') && <View style={{ flex: 1 }}><Button title="Done" variant="secondary" icon="checkmark" onPress={() => void vm.markDone(f.id)} /></View>}
              </View>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}
