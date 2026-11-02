import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { monthName, rupees } from '@/core/format';
import { color } from '@/core/theme';
import { useApi } from '@/core/use-api';
import { Button, Card, Empty, Muted, Notice, Row, Screen, Spinner, Title } from '@/core/ui';
import type { Salary } from '@/models/types';
import { usePayslip } from '@/viewmodels/salary';

interface Detail extends Salary { attendance: { workingDays: number; present: number; late: number; leaveDays: number; absent: number } | null }

function SalaryDetail({ id }: { id: string }) {
  const d = useApi<Detail>(`/salaries/${id}`);
  const payslip = usePayslip(id, d.data?.month ?? '');
  if (d.error) return <Notice tone="bad">{d.error.message}</Notice>;
  if (!d.data) return <Spinner />;
  const s = d.data;
  return (
    <View style={{ gap: 2 }}>
      <Row label="Base pay" value={rupees(s.basePay)} />
      <Row label="Allowances" value={rupees(s.allowances)} />
      <Row label="Deductions" value={rupees(s.deductions)} />
      <Row label="Net pay" value={rupees(s.netPay)} />
      {!!s.notes && <Muted>{s.notes}</Muted>}
      {payslip.error && <Notice tone="bad">{payslip.error}</Notice>}
      <Button title="Payslip PDF" variant="secondary" icon="document-text-outline" loading={payslip.busy} onPress={() => void payslip.open()} />
      {s.attendance && <Muted>Attendance: {s.attendance.present} present of {s.attendance.workingDays} working days · {s.attendance.late} late · {s.attendance.leaveDays} on leave · {s.attendance.absent} absent (for reference only)</Muted>}
    </View>
  );
}

export default function MySalary() {
  const list = useApi<Salary[]>('/salaries/mine');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      <Title>Salary records</Title>
      {list.error && <Notice tone="bad">{list.error.message}</Notice>}
      {!list.data ? <Spinner /> : list.data.length === 0 ? <Empty title="No salary records yet" /> : list.data.map((s) => (
        <Card key={s.id}>
          <Pressable accessibilityRole="button" onPress={() => setOpen(open === s.id ? null : s.id)} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: color.ink, fontWeight: '700' }}>{monthName(s.month)}</Text>
            <Text style={{ color: color.brand600, fontWeight: '800' }}>{rupees(s.netPay)}</Text>
          </Pressable>
          {open === s.id && <SalaryDetail id={s.id} />}
        </Card>
      ))}
    </Screen>
  );
}
