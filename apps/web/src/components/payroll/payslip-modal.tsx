'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Field, Input, Notice, Select, Spinner, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import { errorText, monthName, parseMoney, PayslipDetail, PayslipLine, rupees } from './payroll-types';

/**
 * One payslip with every line and why it is what it is. While the run is a draft, someone who may
 * change salaries (and who is not the person themselves) can change a line or add one, always with a
 * reason; once the run is approved the lines are read only.
 */
export function PayslipModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { me, can } = useAuth();
  const slip = useApi<PayslipDetail>(`/payroll/payslips/${id}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = slip.data;
  const editable = !!d && d.run.status === 'draft' && can('salary.write') && d.user.id !== me?.user.id;

  async function done(): Promise<void> {
    setEditing(null);
    setAdding(false);
    setError(null);
    slip.reload();
    onChanged();
  }

  async function remove(line: PayslipLine): Promise<void> {
    try {
      await api(`/payroll/payslips/${id}/lines/${line.id}`, { method: 'DELETE' });
      await done();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal title={d ? `${d.user.name}, ${monthName(d.month)}` : 'Payslip'} onClose={onClose} width="max-w-2xl">
      {slip.error ? <Notice tone="bad">{slip.error.message}</Notice> : !d ? <Spinner /> : (
        <div className="space-y-4">
          {error && <Notice tone="bad">{error}</Notice>}
          <ul className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[['Pay of one day', rupees(d.facts.dailyRate)], ['Days present', d.presentDays], ['Days absent', d.absentDays], ['Late arrivals', d.lateCount]].map(([k, v]) => (
              <li key={k as string} className="rounded-lg bg-head px-2 py-2"><p className="tabular text-base font-semibold">{v}</p><p className="text-[11px] text-muted">{k}</p></li>
            ))}
          </ul>
          <p className="text-xs text-subtle">
            Working days in the month: {d.facts.workingDays}. Paid leave {d.facts.paidLeaveDays}, unpaid leave {d.facts.unpaidLeaveDays}, half days {d.facts.halfDays}
            {d.facts.breakOverMinutes > 0 ? `, ${d.facts.breakOverMinutes} minutes of break over the allowance` : ''}. A day of pay is base pay divided by {d.facts.basisDays} days.
          </p>

          {(['earning', 'deduction'] as const).map((kind) => (
            <section key={kind}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{kind === 'earning' ? 'Earnings' : 'Deductions'}</h3>
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                {d.lines.filter((l) => l.kind === kind).map((l) => (
                  <li key={l.id} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{l.label} {l.source === 'adjustment' && <Badge tone="info">Added</Badge>} {l.source !== 'adjustment' && l.amount !== l.calculated && <Badge tone="warn">Adjusted</Badge>}</p>
                        {l.detail && <p className="text-xs text-muted">{l.detail}</p>}
                        {l.reason && <p className="text-xs text-muted">Reason: {l.reason}{l.adjustedBy ? `, by ${l.adjustedBy}` : ''}{l.source !== 'adjustment' ? `. Calculated: ${rupees(l.calculated)}` : ''}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="tabular font-semibold">{kind === 'deduction' ? '− ' : ''}{rupees(l.amount)}</span>
                        {editable && <Button size="sm" variant="secondary" onClick={() => setEditing(editing === l.id ? null : l.id)}>Adjust</Button>}
                        {editable && l.source === 'adjustment' && <Button size="sm" variant="ghost" aria-label={`Remove ${l.label}`} onClick={() => void remove(l)}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>}
                      </div>
                    </div>
                    {editing === l.id && <AdjustForm payslipId={id} line={l} onDone={done} />}
                  </li>
                ))}
                {d.lines.filter((l) => l.kind === kind).length === 0 && <li className="px-4 py-2.5 text-muted">None</li>}
              </ul>
            </section>
          ))}

          <dl className="divide-y divide-line rounded-lg border border-line text-sm">
            <div className="flex justify-between px-4 py-2.5"><dt className="text-muted">Total earnings</dt><dd className="tabular">{rupees(d.gross)}</dd></div>
            <div className="flex justify-between px-4 py-2.5"><dt className="text-muted">Total deductions</dt><dd className="tabular">− {rupees(d.deductions)}</dd></div>
            <div className="flex justify-between bg-head px-4 py-2.5"><dt className="font-semibold">Net pay</dt><dd className={`tabular font-bold ${d.netPay < 0 ? 'text-bad' : 'text-brand'}`}>{rupees(d.netPay)}</dd></div>
          </dl>
          {d.netPay < 0 && <Notice tone="bad">This payslip pays less than zero, so the run cannot be approved until it is adjusted.</Notice>}

          {editable && (adding ? <AddForm payslipId={id} onDone={done} onCancel={() => setAdding(false)} /> : (
            <Button variant="secondary" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden /> Add a line</Button>
          ))}
          {!editable && d.run.status === 'approved' && <p className="text-xs text-subtle">This payroll is approved. To change it, the Super Admin reopens the run.</p>}
        </div>
      )}
    </Modal>
  );
}

function AdjustForm({ payslipId, line, onDone }: { payslipId: string; line: PayslipLine; onDone: () => Promise<void> }) {
  const [amount, setAmount] = useState(String(line.amount));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    const n = parseMoney(amount);
    if (n === null) return setError('Enter an amount in rupees, with at most two decimals');
    if (reason.trim().length < 3) return setError('Say why, in a few words');
    setBusy(true);
    try {
      await api(`/payroll/payslips/${payslipId}/lines/${line.id}`, { method: 'PATCH', body: { amount: n, reason: reason.trim() } });
      await onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form className="mt-3 space-y-3 rounded-lg bg-head p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label="New amount (₹)" htmlFor={`amt-${line.id}`}><Input id={`amt-${line.id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Reason" htmlFor={`why-${line.id}`} hint="Kept with the payslip and in the audit log"><Textarea id={`why-${line.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end"><Button type="submit" loading={busy}>Save adjustment</Button></div>
    </form>
  );
}

function AddForm({ payslipId, onDone, onCancel }: { payslipId: string; onDone: () => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<'earning' | 'deduction'>('deduction');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    const n = parseMoney(amount);
    if (!label.trim()) return setError('Give the line a name');
    if (n === null || n <= 0) return setError('Enter an amount above 0, with at most two decimals');
    if (reason.trim().length < 3) return setError('Say why, in a few words');
    setBusy(true);
    try {
      await api(`/payroll/payslips/${payslipId}/lines`, { method: 'POST', body: { kind, label: label.trim(), amount: n, reason: reason.trim() } });
      await onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3 rounded-lg border border-line p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-3 sm:grid-cols-[9rem_1fr_9rem]">
        <Field label="Kind" htmlFor="add-kind">
          <Select id="add-kind" value={kind} onChange={(e) => setKind(e.target.value as 'earning' | 'deduction')}><option value="deduction">Deduction</option><option value="earning">Earning</option></Select>
        </Field>
        <Field label="Name" htmlFor="add-label"><Input id="add-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example Advance recovery" /></Field>
        <Field label="Amount (₹)" htmlFor="add-amount"><Input id="add-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
      <Field label="Reason" htmlFor="add-reason"><Textarea id="add-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button><Button type="submit" loading={busy}>Add line</Button></div>
    </form>
  );
}
