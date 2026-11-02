import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fmtTime } from '@/core/format';
import { useSession } from '@/core/session';
import { color, space } from '@/core/theme';
import { Badge, Button, Card, Chips, Muted, Notice, Row, Screen, Spinner, Title } from '@/core/ui';
import { useWorkDayViewModel } from '@/viewmodels/work-day';

const talk = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

function Kpi({ label, value, tone = color.brand600 }: { label: string; value: number | string; tone?: string }) {
  return (
    <View style={s.kpi}>
      <Text style={{ fontSize: 24, fontWeight: '800', color: tone }}>{value}</Text>
      <Muted>{label}</Muted>
    </View>
  );
}

export default function Today() {
  const { me, can } = useSession();
  const vm = useWorkDayViewModel(can('attendance.self'));
  const [typeId, setTypeId] = useState('');
  const t = vm.today.data;
  const d = vm.dash.data;

  return (
    <Screen onRefresh={vm.refresh} refreshing={vm.dash.loading && !!d}>
      <Title>Hello, {me?.user.name.split(' ')[0]}</Title>

      {can('attendance.self') && (
        <Card>
          <Title>My day</Title>
          {vm.error && <Notice tone="bad">{vm.error}</Notice>}
          {!t ? <Spinner /> : !t.tracked ? <Muted>Your attendance is not tracked.</Muted> : (
            <>
              <Row label="Signed in" value={t.record ? fmtTime(t.record.checkInAt) : 'Not yet'} />
              {!!t.record?.lateMinutes && <Row label="Late by" value={`${t.record.lateMinutes} min`} />}
              {t.shift && <Row label="Shift" value={`${t.shift.start} – ${t.shift.end}`} />}
              <Row label="Break time today" value={`${t.breakMinutesToday ?? 0} min`} />
              {t.onBreak ? (
                <>
                  <Badge tone="warn">{`On ${t.onBreak.type.name} · ${vm.breakMinutes} of ${t.onBreak.type.allowedMinutes} min`}</Badge>
                  <Button title="End break" onPress={() => void vm.endBreak()} loading={vm.busy} />
                </>
              ) : t.checkedIn ? (
                <>
                  <Chips options={(vm.types.data ?? []).map((b) => ({ key: b.id, label: `${b.name} (${b.allowedMinutes} min)` }))} value={typeId} onChange={setTypeId} />
                  <Button title="Start break" variant="secondary" disabled={!typeId} loading={vm.busy} onPress={() => void vm.startBreak(typeId)} />
                </>
              ) : <Muted>Sign in from the office to start your day.</Muted>}
            </>
          )}
        </Card>
      )}

      {vm.dash.error && <Notice tone="bad">{vm.dash.error.message}</Notice>}
      {!d && vm.dash.loading ? <Spinner /> : d && (
        <>
          <View style={s.grid}>
            <Kpi label="Due today" value={d.dueToday} />
            <Kpi label="Overdue" value={d.today.overdueFollowUps} tone={d.today.overdueFollowUps ? color.bad : color.brand600} />
            <Kpi label="Calls today" value={d.today.calls.total} />
            <Kpi label="Connected" value={d.today.calls.connected} tone={color.ok} />
            <Kpi label="Missed" value={d.today.calls.missed} tone={d.today.calls.missed ? color.bad : color.brand600} />
            <Kpi label="Talk time" value={talk(d.today.calls.talkSec)} />
          </View>
          <Card>
            <Title>My leads</Title>
            <Row label="Total" value={d.total} />
            <Row label="Not assigned yet" value={d.unassigned} />
            {d.byStatus.slice(0, 6).map((b) => <Row key={b.status} label={b.status} value={b.leads} />)}
          </Card>
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  kpi: { flexBasis: '47%', flexGrow: 1, backgroundColor: color.surface, borderRadius: 12, borderWidth: 1, borderColor: color.line, padding: space.lg },
});
