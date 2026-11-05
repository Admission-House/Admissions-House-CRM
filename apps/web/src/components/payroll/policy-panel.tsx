'use client';

import { useState } from 'react';
import { Badge, Button, Field, Input, Notice, Panel, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import { errorText, monthName, Policy } from './payroll-types';

interface PolicyAnswer {
  current: Policy;
  history: Policy[];
}

const thisMonth = (): string => new Date().toLocaleDateString('en-CA').slice(0, 7);

/**
 * The rules that turn attendance into deductions, in plain words. Every value is a setting: nothing here
 * is fixed in the program. A new version applies from a month onwards and the old ones stay as history.
 */
export function PolicyPanel() {
  const { can } = useAuth();
  const answer = useApi<PolicyAnswer>('/payroll/policy');
  if (answer.error) return <Notice tone="bad">{answer.error.message}</Notice>;
  if (!answer.data) return <Spinner />;
  return <PolicyForm key={answer.data.current.effectiveFrom ?? 'default'} data={answer.data} canEdit={can('payroll.manage')} onSaved={answer.reload} />;
}

function PolicyForm({ data, canEdit, onSaved }: { data: PolicyAnswer; canEdit: boolean; onSaved: () => void }) {
  const p = data.current;
  const [from, setFrom] = useState(thisMonth());
  const [basis, setBasis] = useState<Policy['workingDaysBasis']>(p.workingDaysBasis);
  const [v, setV] = useState({
    lateFreePerMonth: String(p.lateFreePerMonth), latePenaltyDays: String(p.latePenaltyDays), halfDayDeductionDays: String(p.halfDayDeductionDays),
    absentDeductionDays: String(p.absentDeductionDays), unpaidLeaveDeductionDays: String(p.unpaidLeaveDeductionDays), breakOverrunPerMinute: String(p.breakOverrunPerMinute),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function save(): Promise<void> {
    setError(null);
    setSaved(false);
    const num = (t: string) => (t.trim() === '' || Number.isNaN(Number(t)) ? NaN : Number(t));
    const body = {
      effectiveFrom: from, workingDaysBasis: basis, lateFreePerMonth: num(v.lateFreePerMonth), latePenaltyDays: num(v.latePenaltyDays), halfDayDeductionDays: num(v.halfDayDeductionDays),
      absentDeductionDays: num(v.absentDeductionDays), unpaidLeaveDeductionDays: num(v.unpaidLeaveDeductionDays), breakOverrunPerMinute: num(v.breakOverrunPerMinute),
    };
    if (Object.values(body).some((x) => typeof x === 'number' && Number.isNaN(x))) return setError('Every box needs a number');
    setBusy(true);
    try {
      await api('/payroll/policy', { method: 'PUT', body });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError && e.fieldErrors[0] ? `${e.fieldErrors[0].field}: ${e.fieldErrors[0].message}` : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const days = (label: string, k: keyof typeof v, hint: string) => (
    <Field label={label} htmlFor={`pol-${k}`} hint={hint}><Input id={`pol-${k}`} inputMode="decimal" value={v[k]} onChange={set(k)} disabled={!canEdit} /></Field>
  );

  return (
    <div className="space-y-4">
      {p.isDefault && <Notice tone="info">No rules have been saved yet, so the proposed ones below are used. Save them, or change them, to confirm.</Notice>}
      {error && <Notice tone="bad">{error}</Notice>}
      {saved && <Notice tone="ok">Saved. Calculate a draft payroll again to use the new rules.</Notice>}
      <Panel title="Payroll rules" actions={p.effectiveFrom ? <Badge tone="brand">In force since {monthName(p.effectiveFrom)}</Badge> : <Badge>Proposed</Badge>}>
        <form className="grid gap-4 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (canEdit) void save(); }}>
          <Field label="Applies from" htmlFor="pol-from" hint="The first month these rules are used"><Input id="pol-from" type="month" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} disabled={!canEdit} /></Field>
          <Field label="How the pay of one day is found" htmlFor="pol-basis" hint="Base pay divided by the days of this basis">
            <Select id="pol-basis" value={basis} onChange={(e) => setBasis(e.target.value as Policy['workingDaysBasis'])} disabled={!canEdit}>
              <option value="working">Working days (without weekly offs and holidays)</option>
              <option value="calendar">Calendar days</option>
            </Select>
          </Field>
          {days('Absent without leave (days of pay per day)', 'absentDeductionDays', 'A working day with no attendance and no approved leave')}
          {days('Unpaid leave (days of pay per day)', 'unpaidLeaveDeductionDays', 'A day of approved leave of a type that is not paid')}
          {days('Half day (days of pay per half day)', 'halfDayDeductionDays', 'A day worked for fewer hours than the half-day line in Attendance settings')}
          {days('Late arrivals free in a month', 'lateFreePerMonth', 'Counted against the shift start and grace set in Attendance settings')}
          {days('Each late arrival after that (days of pay)', 'latePenaltyDays', 'Use 0 for no penalty. Steps of 0.25')}
          {days('Break over its allowance (₹ per minute)', 'breakOverrunPerMinute', 'Use 0 for no penalty')}
          {canEdit && <div className="flex items-end justify-end sm:col-span-2"><Button type="submit" loading={busy}>Save rules</Button></div>}
        </form>
      </Panel>
      {!canEdit && <p className="text-xs text-subtle">Only the Super Admin can change the rules.</p>}
      {data.history.length > 0 && (
        <Panel title="Earlier versions" flush>
          <ul className="divide-y divide-line text-sm">
            {data.history.map((h) => (
              <li key={h.effectiveFrom} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="font-medium">From {h.effectiveFrom ? monthName(h.effectiveFrom) : ''}</span>
                <span className="text-muted">{h.workingDaysBasis === 'working' ? 'Working days' : 'Calendar days'}, absent {h.absentDeductionDays}, unpaid leave {h.unpaidLeaveDeductionDays}, half day {h.halfDayDeductionDays}, late: {h.lateFreePerMonth} free then {h.latePenaltyDays}, break ₹{h.breakOverrunPerMinute}/min</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
