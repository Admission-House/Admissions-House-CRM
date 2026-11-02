import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { api } from '@/core/api';
import { DateField } from '@/core/date-field';
import { fmtDate, ymd } from '@/core/format';
import { color } from '@/core/theme';
import { errorText, useApi } from '@/core/use-api';
import { Badge, Button, Card, Chips, Empty, Field, Muted, Notice, Row, Screen, Spinner, Title } from '@/core/ui';
import type { Balances, LeaveRequest, LeaveStatus, LeaveType, Page } from '@/models/types';

const STATUS: Record<LeaveStatus, { label: string; tone: 'warn' | 'ok' | 'bad' | 'neutral' }> = {
  pending: { label: 'Waiting', tone: 'warn' }, approved: { label: 'Approved', tone: 'ok' }, rejected: { label: 'Turned down', tone: 'bad' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const span = (r: LeaveRequest) => (r.fromDate === r.toDate ? fmtDate(`${r.fromDate}T00:00:00`) : `${fmtDate(`${r.fromDate}T00:00:00`)} to ${fmtDate(`${r.toDate}T00:00:00`)}`);

export default function Leave() {
  const types = useApi<LeaveType[]>('/leave/types');
  const bal = useApi<Balances>('/leave/balances');
  const mine = useApi<Page<LeaveRequest>>('/leave/requests/mine', { limit: 100 });
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);
  const [half, setHalf] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const active = (types.data ?? []).filter((t) => t.isActive);
  const reload = () => { mine.reload(); bal.reload(); };

  async function submit() {
    if (!from) return;
    setBusy(true);
    setNotice(null);
    try {
      await api('/leave/requests', { method: 'POST', body: { leaveTypeId: typeId, fromDate: ymd(from), ...(to && !half && { toDate: ymd(to) }), halfDay: half, ...(reason.trim() && { reason: reason.trim() }) } });
      setNotice({ tone: 'ok', text: 'Your request was sent.' });
      setFrom(null); setTo(null); setHalf(false); setReason('');
      reload();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(r: LeaveRequest) {
    setNotice(null);
    try { await api(`/leave/requests/${r.id}/cancel`, { method: 'POST', body: {} }); reload(); } catch (e) { setNotice({ tone: 'bad', text: errorText(e) }); }
  }

  return (
    <Screen onRefresh={reload} refreshing={mine.loading && !!mine.data}>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Card>
        <Title>Balance {bal.data ? bal.data.year : ''}</Title>
        {!bal.data ? <Spinner /> : bal.data.balances.map((b) => (
          <Row key={b.leaveType.id} label={b.leaveType.name} value={b.available === null ? 'No limit' : `${b.available} left`} />
        ))}
      </Card>

      <Card>
        <Title>Ask for leave</Title>
        <Chips options={active.map((t) => ({ key: t.id, label: t.name }))} value={typeId} onChange={setTypeId} />
        <DateField label={half ? 'Date' : 'From'} value={from} onChange={setFrom} minimum={new Date()} />
        {!half && <DateField label="To (leave empty for one day)" value={to} onChange={setTo} minimum={from ?? new Date()} />}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: color.ink, fontWeight: '600' }}>Half day</Text>
          <Switch value={half} onValueChange={setHalf} trackColor={{ true: color.brand600 }} />
        </View>
        <Field label="Reason (optional)" value={reason} onChangeText={setReason} multiline maxLength={500} style={{ minHeight: 70, textAlignVertical: 'top' }} />
        <Button title="Send request" loading={busy} disabled={!typeId || !from} onPress={() => void submit()} />
      </Card>

      <Card>
        <Title>My requests</Title>
        {mine.error && <Notice tone="bad">{mine.error.message}</Notice>}
        {!mine.data ? <Spinner /> : mine.data.items.length === 0 ? <Empty title="No requests yet" /> : mine.data.items.map((r) => (
          <View key={r.id} style={{ paddingVertical: 8, gap: 4, borderTopWidth: 1, borderTopColor: color.line }}>
            <Text style={{ color: color.ink, fontWeight: '600' }}>{r.leaveType.name} · {span(r)}</Text>
            <Muted>{r.days} {r.days === 1 ? 'day' : 'days'}{r.reason ? ` · ${r.reason}` : ''}</Muted>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
              {r.status === 'pending' && <Button title="Cancel" variant="secondary" onPress={() => void cancel(r)} />}
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
