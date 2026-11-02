import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fmtPhone, fromNow } from '@/core/format';
import { color, radius, space } from '@/core/theme';
import { Avatar, Badge, Chips, Empty, Notice, Spinner } from '@/core/ui';
import { QUEUES, useLeadsViewModel } from '@/viewmodels/leads';
import type { LeadListItem } from '@/models/types';

const INTENT = { hot: 'bad', warm: 'warn', cold: 'info' } as const;

function LeadRow({ lead, onOpen }: { lead: LeadListItem; onOpen: () => void }) {
  const late = !!lead.nextFollowupAt && new Date(lead.nextFollowupAt) < new Date();
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={({ pressed }) => [s.row, pressed && { backgroundColor: color.head }]}>
      <Avatar name={lead.name} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.name} numberOfLines={1}>{lead.name}</Text>
        <Text style={s.sub}>{fmtPhone(lead.phone)} · {lead.source.name}</Text>
        {lead.nextFollowupAt && <Text style={[s.sub, late && { color: color.bad, fontWeight: '600' }]}>Follow-up {fromNow(lead.nextFollowupAt)}</Text>}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Badge tone={lead.status.queue === 'missed' ? 'bad' : lead.status.isOpen ? 'brand' : 'neutral'}>{lead.status.name}</Badge>
        {lead.intent && <Badge tone={INTENT[lead.intent]}>{lead.intent}</Badge>}
      </View>
    </Pressable>
  );
}

export default function Leads() {
  const vm = useLeadsViewModel();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: color.canvas }}>
      <View style={s.top}>
        <View style={s.search}>
          <Ionicons name="search" size={18} color={color.subtle} />
          <TextInput value={vm.typed} onChangeText={vm.setTyped} placeholder="Search name, phone or lead no." placeholderTextColor={color.subtle} style={s.input} autoCorrect={false} returnKeyType="search" />
        </View>
        <Chips options={QUEUES.map((q) => ({ key: q.key, label: `${q.label}${vm.count(q.key) !== undefined ? ` ${vm.count(q.key)}` : ''}` }))} value={vm.queue} onChange={vm.setQueue}
        />
      </View>
      {vm.error && <View style={{ padding: space.lg }}><Notice tone="bad">{vm.error.message}</Notice></View>}
      {vm.loading ? <Spinner /> : (
        <FlatList
          data={vm.items}
          keyExtractor={(l) => l.id}
          renderItem={({ item }) => <LeadRow lead={item} onOpen={() => router.push(`/lead/${item.id}`)} />}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: color.line }} />}
          ListEmptyComponent={<Empty title="No leads here" hint="Try another queue or clear the search." />}
          ListFooterComponent={<View>{vm.loadingMore ? <ActivityIndicator style={{ margin: space.lg }} color={color.brand600} /> : vm.moreError ? <Notice tone="bad">{vm.moreError}</Notice> : null}</View>}
          onEndReached={() => void vm.loadMore()}
          onEndReachedThreshold={0.4}
          refreshing={vm.refreshing}
          onRefresh={vm.refresh}
          style={{ backgroundColor: color.surface }}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  top: { padding: space.md, gap: space.sm, backgroundColor: color.canvas },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.lineStrong, paddingHorizontal: space.md },
  input: { flex: 1, minHeight: 44, fontSize: 15, color: color.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, paddingHorizontal: space.lg },
  name: { fontSize: 15, fontWeight: '700', color: color.ink },
  sub: { fontSize: 12, color: color.muted },
});
