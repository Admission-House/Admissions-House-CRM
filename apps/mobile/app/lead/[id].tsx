import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { DateField } from '@/core/date-field';
import { fmtDate, fmtDateTime, fmtPhone, fromNow } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Avatar, Badge, Button, Card, Chips, Empty, Field, Muted, Notice, Row, Screen, Spinner, Title } from '@/core/ui';
import { CallsTab } from '@/features/lead/calls-tab';
import { CollegesTab } from '@/features/lead/colleges-tab';
import { DocumentsTab } from '@/features/lead/documents-tab';
import { ProfileTab } from '@/features/lead/profile-tab';
import { ShortlistTab } from '@/features/lead/shortlist-tab';
import { describeActivity } from '@/models/activity-text';
import { useLeadViewModel } from '@/viewmodels/lead';

type Tab = 'activity' | 'profile' | 'colleges' | 'shortlisted' | 'nidnp' | 'reconciled' | 'documents' | 'calls';

export default function LeadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useSession();
  const vm = useLeadViewModel(id);
  const l = vm.lead.data;

  const [tab, setTab] = useState<Tab>('activity');
  const [statusId, setStatusId] = useState('');
  const [substatusId, setSubstatusId] = useState('');
  const [remark, setRemark] = useState('');
  const [due, setDue] = useState<Date | null>(null);
  const [note, setNote] = useState('');
  const [fuDue, setFuDue] = useState<Date | null>(null);
  const [fuNote, setFuNote] = useState('');

  if (vm.lead.loading && !l) return <Spinner />;
  if (!l) {
    return <Screen><Notice tone="bad">{vm.lead.error?.status === 404 ? 'This lead does not exist, or it is not one you can see.' : (vm.lead.error?.message ?? 'Could not load this lead.')}</Notice></Screen>;
  }

  const options = (vm.statuses.data ?? []).filter((s) => s.isActive !== false);
  const chosen = options.find((s) => s.id === (statusId || l.status.id));
  const changing = !!statusId && statusId !== l.status.id;
  const needsDate = !!chosen && chosen.isOpen && chosen.requiresFollowup && l.openFollowUps === 0;
  const wa = l.phone.replace(/\D/g, '');
  const followUps = vm.followUps.data ?? [];
  const acts = vm.activities.data?.items ?? [];
  const tabOptions: { key: Tab; label: string }[] = [
    { key: 'activity', label: 'Activity' },
    { key: 'profile', label: 'Profile' },
    { key: 'colleges', label: 'Colleges' },
    { key: 'shortlisted', label: 'Shortlisted' },
    { key: 'nidnp', label: 'NI / DNP' },
    { key: 'reconciled', label: 'Reconciled' },
    { key: 'documents', label: 'Documents' },
    ...(can('call.read') ? [{ key: 'calls' as const, label: 'Calls' }] : []),
  ];

  async function saveStatus() {
    const ok = await vm.changeStatus({ statusId: statusId || l!.status.id, substatusId: substatusId || undefined, remark, followUpAt: due ?? undefined });
    if (ok) { setStatusId(''); setSubstatusId(''); setRemark(''); setDue(null); }
  }

  return (
    <Screen onRefresh={vm.reloadAll} refreshing={vm.lead.loading}>
      <Stack.Screen options={{ title: l.name }} />
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <Avatar name={l.name} size={48} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: color.ink }}>{l.name}</Text>
            <Muted>Lead {l.leadNo} · {fmtPhone(l.phone)}</Muted>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Badge tone={l.status.queue === 'missed' ? 'bad' : l.status.isOpen ? 'brand' : 'neutral'}>{`${l.status.name}${l.substatus ? ` · ${l.substatus.name}` : ''}`}</Badge>
          {l.intent && <Badge tone={l.intent === 'hot' ? 'bad' : l.intent === 'warm' ? 'warn' : 'info'}>{l.intent}</Badge>}
        </View>
        {vm.notice && <Notice tone={vm.notice.tone}>{vm.notice.text}</Notice>}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {can('call.place') && l.status.isOpen && <View style={{ flex: 1 }}><Button title="Call" icon="call" loading={vm.busy === 'call'} onPress={() => void vm.call()} /></View>}
          <View style={{ flex: 1 }}><Button title="WhatsApp" variant="secondary" icon="logo-whatsapp" onPress={() => void Linking.openURL(`https://wa.me/${wa}`)} /></View>
          <View style={{ flex: 1 }}><Button title="SMS" variant="secondary" icon="chatbubble-outline" onPress={() => void Linking.openURL(`sms:+${wa}`)} /></View>
        </View>
        <Row label="Source" value={l.source.name} />
        <Row label="Assigned to" value={l.assignedTo?.name} />
        <Row label="Study mode" value={l.studyMode} />
        <Row label="Expected closure" value={fmtDate(l.expectedClosureOn)} />
        <Row label="Next follow-up" value={l.nextFollowupAt ? `${fmtDateTime(l.nextFollowupAt)} (${fromNow(l.nextFollowupAt)})` : ''} />
        {l.extraPhones.map((p) => <Row key={p.phone} label={p.label} value={fmtPhone(p.phone)} />)}
        {!!l.interestNote && <Muted>{l.interestNote}</Muted>}
      </Card>

      <Chips options={tabOptions} value={tab} onChange={setTab} />

      {tab === 'profile' && <ProfileTab lead={l} />}
      {tab === 'colleges' && <CollegesTab lead={l} onChanged={vm.reloadAll} />}
      {tab === 'shortlisted' && <ShortlistTab key="a" leadId={l.id} view="active" empty="No college shortlisted yet" onChanged={vm.reloadAll} />}
      {tab === 'nidnp' && <ShortlistTab key="n" leadId={l.id} view="ni_dnp" empty="No college found" onChanged={vm.reloadAll} />}
      {tab === 'reconciled' && <ShortlistTab key="r" leadId={l.id} view="reconciled" empty="No reconciled colleges yet" onChanged={vm.reloadAll} />}
      {tab === 'documents' && <DocumentsTab leadId={l.id} />}
      {tab === 'calls' && <CallsTab leadId={l.id} onChanged={vm.reloadAll} />}

      {tab === 'activity' && (
        <>
        {can('lead.update') && (
          <Card>
            <Title>Update status</Title>
            <Chips options={options.map((s) => ({ key: s.id, label: s.name }))} value={statusId || l.status.id} onChange={(v) => { setStatusId(v); setSubstatusId(''); }} />
            {chosen?.substatuses && chosen.substatuses.length > 0 && (
              <Chips options={[{ key: '', label: 'No sub-status' }, ...chosen.substatuses.map((s) => ({ key: s.id, label: s.name }))]} value={substatusId} onChange={setSubstatusId} />
            )}
            {can('followup.manage') && chosen?.isOpen && (
              <DateField label={needsDate ? 'Next follow-up (required)' : 'Next follow-up (optional)'} withTime value={due} onChange={setDue} minimum={new Date()} />
            )}
            <Field label="Remark" value={remark} onChangeText={setRemark} placeholder="What was discussed?" multiline maxLength={1000} style={{ minHeight: 80, textAlignVertical: 'top' }} />
            <Button title="Save" loading={vm.busy === 'status'} disabled={(!changing && !remark.trim() && !due) || (needsDate && !due && changing)} onPress={() => void saveStatus()} />
          </Card>
        )}

        <Card>
          <Title>Follow-ups</Title>
          {can('followup.manage') && l.status.isOpen && (
            <>
              <DateField label="When" withTime value={fuDue} onChange={setFuDue} minimum={new Date()} />
              <Field label="Note" value={fuNote} onChangeText={setFuNote} placeholder="What to do (optional)" maxLength={500} />
              <Button title="Add follow-up" variant="secondary" disabled={!fuDue} loading={vm.busy === 'followup'} onPress={() => void vm.addFollowUp(fuDue!, fuNote).then((ok) => { if (ok) { setFuDue(null); setFuNote(''); } })} />
            </>
          )}
          {followUps.length === 0 ? <Empty title="No follow-ups yet" /> : followUps.map((f) => {
            const late = !f.doneAt && new Date(f.dueAt) < new Date();
            return (
              <View key={f.id} style={{ paddingVertical: 8, gap: 2 }}>
                <Text style={{ fontWeight: '600', color: late ? color.bad : color.ink }}>{fmtDateTime(f.dueAt)} · {fromNow(f.dueAt)}</Text>
                {!!f.note && <Muted>{f.note}</Muted>}
                {f.doneAt ? <Badge tone="ok">Done</Badge> : can('followup.manage') ? <Button title="Mark done" variant="secondary" icon="checkmark" onPress={() => void vm.doneFollowUp(f.id)} /> : null}
              </View>
            );
          })}
        </Card>

        <Card>
          <Title>Activity</Title>
          {can('lead.update') && (
            <>
              <Field label="Add a note" value={note} onChangeText={setNote} multiline maxLength={1000} style={{ minHeight: 70, textAlignVertical: 'top' }} />
              <Button title="Add note" variant="secondary" disabled={!note.trim()} loading={vm.busy === 'note'} onPress={() => void vm.addNote(note).then((ok) => { if (ok) setNote(''); })} />
            </>
          )}
          {acts.length === 0 ? <Empty title="Nothing yet" /> : acts.map((a) => (
            <View key={a.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: color.line, gap: 2 }}>
              <Text style={{ color: color.ink }}>{describeActivity(a)}</Text>
              <Muted>{a.user?.name ?? 'System'} · {fromNow(a.createdAt)}</Muted>
            </View>
          ))}
        </Card>
        </>
      )}
    </Screen>
  );
}
