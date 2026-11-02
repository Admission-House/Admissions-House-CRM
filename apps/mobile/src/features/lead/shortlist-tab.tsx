import { useState } from 'react';
import { Text, View } from 'react-native';
import { fmtDateTime } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { Badge, Button, Card, Chips, Empty, Field, Muted, Notice, Sheet, Spinner, Title } from '@/core/ui';
import type { Shortlist, ShortlistView } from '@/models/types';
import { rupees } from '@/viewmodels/colleges';
import { FORM_STATUS, RECON_STATUS, useShortlistViewModel } from '@/viewmodels/shortlist';
import { CoursePicker } from './course-picker';

type Vm = ReturnType<typeof useShortlistViewModel>;

function PaymentBox({ s, manage, vm }: { s: Shortlist; manage: boolean; vm: Vm }) {
  const [amount, setAmount] = useState('');
  const paid = s.payment.status === 'completed' || s.payment.amount !== null;
  return (
    <View style={{ gap: 6 }}>
      <Muted>Payment status</Muted>
      {paid ? (
        <>
          <Badge tone="ok">Payment completed</Badge>
          <Text style={{ color: color.ink }}>Amount: <Text style={{ fontWeight: '700' }}>{rupees(s.payment.amount)}</Text>{s.payment.paidAt ? ` · ${fmtDateTime(s.payment.paidAt)}` : ''}</Text>
          {manage && <Button title="Remove this payment" variant="secondary" loading={vm.busy === `pay${s.id}`} onPress={() => void vm.clearPayment(s.id)} />}
        </>
      ) : manage ? (
        <>
          <Field label="Amount paid (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Amount" />
          <Button title="Record payment" variant="secondary" disabled={!(Number(amount) > 0)} loading={vm.busy === `pay${s.id}`} onPress={() => void vm.recordPayment(s.id, Number(amount)).then((ok) => { if (ok) setAmount(''); })} />
        </>
      ) : <Muted>Not paid yet</Muted>}
    </View>
  );
}

/** Mark one shortlisted college as not interested (NI) or did not pick (DNP), with a reason. */
function NiDnpSheet({ s, vm, onClose }: { s: Shortlist; vm: Vm; onClose: () => void }) {
  const [kind, setKind] = useState<'ni' | 'dnp'>('ni');
  const [reason, setReason] = useState('');
  return (
    <Sheet title="Not interested or did not pick" onClose={onClose}>
      <Card>
        <Muted>What happened</Muted>
        <Chips options={[{ key: 'ni', label: 'Not interested (NI)' }, { key: 'dnp', label: 'Did not pick (DNP)' }]} value={kind} onChange={setKind} />
        <Field label="Reason" value={reason} onChangeText={setReason} placeholder="So the next person knows why (at least 3 characters)" multiline maxLength={300} style={{ minHeight: 80, textAlignVertical: 'top' }} />
        <Button title="Save" disabled={reason.trim().length < 3} loading={vm.busy === `nidnp${s.id}`} onPress={() => void vm.markNiDnp(s.id, kind, reason).then((ok) => { if (ok) onClose(); })} />
      </Card>
    </Sheet>
  );
}

function ShortlistCard({ leadId, s, manage, vm, onChanged }: { leadId: string; s: Shortlist; manage: boolean; vm: Vm; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);
  return (
    <Card>
      <Text style={{ fontWeight: '700', color: color.info, fontSize: 15 }}>{s.college.name}</Text>
      <Muted>{s.college.location ?? ''}{s.shortlistedBy ? ` · by ${s.shortlistedBy}` : ''} · {fmtDateTime(s.createdAt)}</Muted>
      {s.niDnp && <Badge tone={s.niDnp.kind === 'ni' ? 'warn' : 'bad'}>{s.niDnp.kind === 'ni' ? 'Not interested' : 'Did not pick'}</Badge>}
      {!!s.niDnp?.reason && <Muted>{s.niDnp.reason}</Muted>}

      <Muted>Product status</Muted>
      <Chips options={FORM_STATUS} value={s.formStatus} onChange={(v) => { if (manage && v !== s.formStatus) void vm.setFormStatus(s.id, v); }} />
      <Muted>Reconciliation status</Muted>
      <Chips options={RECON_STATUS} value={s.reconciliationStatus} onChange={(v) => { if (manage && v !== s.reconciliationStatus) void vm.setReconciliation(s.id, v); }} />
      <PaymentBox s={s} manage={manage} vm={vm} />

      <Title>Shortlisted courses ({s.courses.length})</Title>
      {s.courses.length === 0 ? <Muted>No courses chosen yet.</Muted> : s.courses.map((c) => (
        <View key={c.collegeCourseId} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.line }}>
          <Text style={{ fontWeight: '600', color: color.info }}>{c.course.name}</Text>
          <Muted>CAF {rupees(c.cafFee)} · Fee {rupees(c.annualFee)} a year{c.durationYears ? ` · ${c.durationYears} years` : ''}</Muted>
        </View>
      ))}

      {manage && (
        <View style={{ gap: 8, marginTop: 4 }}>
          <Button title="Add or change courses" variant="secondary" onPress={() => setEditing(true)} />
          {s.niDnp
            ? <Button title="Move back" variant="secondary" loading={vm.busy === `nidnp${s.id}`} onPress={() => void vm.undoNiDnp(s.id)} />
            : <Button title="Mark NI / DNP" variant="secondary" onPress={() => setMarking(true)} />}
          <Button title="Remove" variant="danger" loading={vm.busy === `rm${s.id}`} onPress={() => void vm.remove(s.id)} />
        </View>
      )}
      {editing && <CoursePicker leadId={leadId} college={s.college} existing={s} onClose={() => setEditing(false)} onDone={() => { setEditing(false); vm.list.reload(); onChanged(); }} />}
      {marking && <NiDnpSheet s={s} vm={vm} onClose={() => setMarking(false)} />}
    </Card>
  );
}

/** One list of shortlisted colleges: the active ones, the ones marked NI or DNP, or the reconciled ones. */
export function ShortlistTab({ leadId, view, empty, onChanged }: { leadId: string; view: ShortlistView; empty: string; onChanged: () => void }) {
  const { can } = useSession();
  const vm = useShortlistViewModel(leadId, view, onChanged);
  if (vm.list.loading && !vm.list.data) return <Spinner />;
  return (
    <>
      {vm.error && <Notice tone="bad">{vm.error}</Notice>}
      {vm.list.error && <Notice tone="bad">{vm.list.error.message}</Notice>}
      {(vm.list.data?.length ?? 0) === 0 ? <Card><Empty title={empty} /></Card> : vm.list.data!.map((s) => (
        <ShortlistCard key={s.id} leadId={leadId} s={s} manage={can('shortlist.manage')} vm={vm} onChanged={onChanged} />
      ))}
    </>
  );
}
