import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';
import { fmtDateTime } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Badge, Button, Card, Empty, Muted, Notice, Spinner } from '@/core/ui';
import { WrapUpForm } from '@/core/wrap-up-form';
import { OUTCOME, callLength } from '@/viewmodels/calls';
import { useLeadCallsViewModel } from '@/viewmodels/lead-calls';

/** Every call with this lead, and the after-call form for a connected call that has none yet. */
export function CallsTab({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const { can } = useSession();
  const vm = useLeadCallsViewModel(leadId, onChanged);
  const items = vm.list.data?.items ?? [];

  return (
    <>
      {vm.list.error && <Notice tone="bad">{vm.list.error.message}</Notice>}
      {vm.wrapping && (
        <WrapUpForm statuses={vm.statuses.data ?? []} loadError={vm.statuses.error?.message} busy={vm.busy} error={vm.error} onSave={(input) => void vm.wrapUp(input)} onCancel={vm.closeWrapUp} />
      )}
      {vm.list.loading && !vm.list.data ? <Spinner /> : items.length === 0 ? <Card><Empty title="No calls yet" hint="Calls with this lead will show here." /></Card> : items.map((c) => {
        const o = OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const };
        const incoming = c.direction === 'incoming';
        return (
          <Card key={c.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name={incoming ? 'arrow-down-circle' : 'arrow-up-circle'} size={22} color={incoming ? color.info : color.ok} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '700', color: color.ink }}>{incoming ? 'Incoming' : 'Outgoing'} · {callLength(c.durationSec)}</Text>
                <Muted>{fmtDateTime(c.startedAt)}{c.user ? ` · ${c.user.name}` : ''}</Muted>
              </View>
              <Badge tone={o.tone}>{o.label}</Badge>
            </View>
            {!!c.remark && <Text style={{ color: color.ink }}>{c.remark}</Text>}
            {c.recording === 'pending' && <Muted>Recording on its way</Muted>}
            {c.outcome === 'connected' && !c.wrappedUp && can('lead.update') && (
              <Button title="After-call form" variant="secondary" icon="clipboard-outline" onPress={() => vm.startWrapUp(c.id)} />
            )}
          </Card>
        );
      })}
    </>
  );
}
