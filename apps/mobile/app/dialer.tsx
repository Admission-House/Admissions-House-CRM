import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { fmtPhone } from '@/core/format';
import { color } from '@/core/theme';
import { Badge, Button, Card, Chips, Empty, Muted, Notice, Screen, Spinner, Title } from '@/core/ui';
import { WrapUpForm } from '@/core/wrap-up-form';
import type { DialerLead } from '@/models/types';
import { DIAL_QUEUES, useDialerViewModel } from '@/viewmodels/dialer';

type Vm = ReturnType<typeof useDialerViewModel>;

const STATE: Record<DialerLead['state'], { label: string; tone: 'neutral' | 'ok' | 'warn' }> = {
  pending: { label: 'Waiting', tone: 'neutral' }, called: { label: 'Called', tone: 'ok' }, skipped: { label: 'Skipped', tone: 'warn' },
};

/** The after-call form for the call that is holding up the next one. */
function WrapUpCard({ vm }: { vm: Vm }) {
  return (
    <WrapUpForm
      statuses={vm.statuses.data ?? []}
      loadError={vm.statuses.error?.message}
      busy={vm.busy === 'wrap'}
      hint="Choose what the lead's status is now. Then you can call the next one."
      onSave={(input) => void vm.wrapUp(input)}
      onCancel={vm.closeWrap}
    />
  );
}

/** Nothing running: pick a queue and which of the person's own leads to call, then start. */
function StartCard({ vm }: { vm: Vm }) {
  const label = (k: string, name: string) => `${name}${vm.queues.data ? ` ${vm.queues.data.queues[k] ?? 0}` : ''}`;
  return (
    <>
      <Card>
        <Title>Start a dialing session</Title>
        <Muted>Your own open leads are called one after another, in this order.</Muted>
        <Chips options={DIAL_QUEUES.map((q) => ({ key: q.key, label: label(q.key, q.label) }))} value={vm.queue} onChange={vm.changeQueue} />
        <Button title={`Start dialing (${vm.chosen.length})`} icon="play" disabled={vm.chosen.length === 0} loading={vm.busy === 'start'} onPress={() => void vm.start()} />
      </Card>
      {vm.leads.error && <Notice tone="bad">{vm.leads.error.message}</Notice>}
      {vm.leads.loading && !vm.leads.data ? <Spinner /> : vm.dialable.length === 0 ? (
        <Empty title="No leads to dial here" hint="Nothing in this list is assigned to you and still open." />
      ) : vm.dialable.map((l) => {
        const on = !vm.unpicked[l.id];
        return (
          <Pressable key={l.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => vm.toggle(l.id)}>
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Ionicons name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? color.brand600 : color.subtle} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: color.ink, fontSize: 15 }}>{l.name}</Text>
                  <Muted>{fmtPhone(l.phone)} · #{l.leadNo}</Muted>
                </View>
                <Badge tone="brand">{l.status.name}</Badge>
              </View>
            </Card>
          </Pressable>
        );
      })}
    </>
  );
}

/** A session is running or paused: the lead in line, the controls, and the list. */
function SessionCard({ vm }: { vm: Vm }) {
  const router = useRouter();
  const s = vm.session.data!;
  const done = s.counts.called + s.counts.skipped;
  const percent = s.counts.total ? Math.round((done / s.counts.total) * 100) : 0;
  const paused = s.status === 'paused';

  return (
    <>
      <Card>
        <Muted>{paused ? 'Paused' : 'Next in line'}</Muted>
        {s.current ? (
          <>
            <Text style={{ fontSize: 22, fontWeight: '800', color: color.ink }} onPress={() => router.push(`/lead/${s.current!.leadId}`)}>{s.current.name}</Text>
            <Muted>{fmtPhone(s.current.phone)} · #{s.current.leadNo}</Muted>
          </>
        ) : <Text style={{ fontSize: 18, fontWeight: '700', color: color.ink }}>Everyone has been called</Text>}
        <View style={{ gap: 6, marginTop: 4 }}>
          <Text style={{ fontWeight: '600', color: color.ink }}>{done} of {s.counts.total} done</Text>
          <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }} style={{ height: 8, borderRadius: 4, backgroundColor: color.line, overflow: 'hidden' }}>
            <View style={{ width: `${percent}%`, height: '100%', backgroundColor: color.brand600 }} />
          </View>
          <Muted>{s.counts.called} called · {s.counts.skipped} skipped · {s.counts.pending} waiting</Muted>
        </View>
        {paused ? (
          <Button title="Resume" icon="play" loading={vm.busy === 'resume'} onPress={() => void vm.act('resume')} />
        ) : (
          <>
            <Button title="Call now" icon="call" disabled={!s.current} loading={vm.busy === 'dial'} onPress={() => void vm.act('dial')} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><Button title="Skip" variant="secondary" icon="play-skip-forward" disabled={!s.current} loading={vm.busy === 'skip'} onPress={() => void vm.act('skip')} /></View>
              <View style={{ flex: 1 }}><Button title="Pause" variant="secondary" icon="pause" loading={vm.busy === 'pause'} onPress={() => void vm.act('pause')} /></View>
            </View>
          </>
        )}
        <Button title="End session" variant="danger" icon="stop" loading={vm.busy === 'stop'} onPress={() => void vm.act('stop')} />
      </Card>

      {vm.wrapCallId && <WrapUpCard vm={vm} />}

      <Card>
        <Title>Leads in this session</Title>
        {(s.leads ?? []).map((l, i) => (
          <View key={l.leadId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, backgroundColor: s.current?.leadId === l.leadId ? color.mintSoft : undefined }}>
            <Text style={{ width: 22, color: color.subtle, fontSize: 12 }}>{i + 1}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '600', color: color.ink }} onPress={() => router.push(`/lead/${l.leadId}`)}>{l.name}</Text>
              <Muted>{fmtPhone(l.phone)}</Muted>
            </View>
            <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge>
          </View>
        ))}
      </Card>
    </>
  );
}

export default function Dialer() {
  const vm = useDialerViewModel();
  return (
    <Screen onRefresh={vm.refresh} refreshing={vm.session.loading && !!vm.session.data}>
      {vm.notice && <Notice tone={vm.notice.tone}>{vm.notice.text}</Notice>}
      {vm.session.error && <Notice tone="bad">{vm.session.error.message}</Notice>}
      {vm.loadingSession ? <Spinner /> : vm.hasSession ? <SessionCard vm={vm} /> : !vm.session.error && <StartCard vm={vm} />}
    </Screen>
  );
}
