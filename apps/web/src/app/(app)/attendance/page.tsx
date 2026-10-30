'use client';

import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Panel, Select, Spinner, Tabs, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import type { Report } from '@/components/reports/report-view';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Record_ {
  id: string;
  user: { id: string; name: string };
  workDate: string;
  checkInAt: string;
  checkOutAt: string | null;
  checkOutReason: string | null;
  lateMinutes: number;
  method: 'office_check' | 'exception';
  presentMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const hm = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const ymd = (d: Date) => d.toLocaleDateString('en-CA');
const OUT_REASON: Record<string, string> = { manual: 'Signed out', shift_end: 'End of shift', inactivity: 'Inactive for too long', forced: 'Signed out by an admin' };

function RecordsTable({ rows, showPerson }: { rows: Record_[]; showPerson?: boolean }) {
  if (rows.length === 0) return <Empty title="No attendance in this period" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-head text-xs uppercase tracking-wide text-muted">
          <tr><th className="px-4 py-2.5 font-semibold">Day</th>{showPerson && <th className="px-3 py-2.5 font-semibold">Person</th>}<th className="px-3 py-2.5 font-semibold">In</th><th className="px-3 py-2.5 font-semibold">Out</th><th className="px-3 py-2.5 font-semibold">Late</th><th className="px-3 py-2.5 font-semibold">Breaks</th><th className="px-3 py-2.5 font-semibold">Worked</th><th className="px-3 py-2.5 font-semibold">How</th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-mint-50">
              <td className="whitespace-nowrap px-4 py-3 font-medium">{day(r.workDate)}</td>
              {showPerson && <td className="px-3 py-3">{r.user.name}</td>}
              <td className="tabular px-3 py-3">{clock(r.checkInAt)}</td>
              <td className="tabular px-3 py-3">{r.checkOutAt ? clock(r.checkOutAt) : <span className="text-muted">Still in</span>}{r.checkOutReason && <span className="block text-xs text-muted">{OUT_REASON[r.checkOutReason] ?? r.checkOutReason}</span>}</td>
              <td className="px-3 py-3">{r.lateMinutes > 0 ? <Badge tone="warn">{r.lateMinutes} min late</Badge> : <span className="text-muted">On time</span>}</td>
              <td className="tabular px-3 py-3">{r.breakMinutes} min</td>
              <td className="tabular px-3 py-3">{hm(r.workedMinutes)}</td>
              <td className="px-3 py-3">{r.method === 'exception' ? <Badge tone="info">Marked by an admin</Badge> : <Badge tone="ok">Office sign-in</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- my attendance

function MyAttendance() {
  const [month, setMonth] = useState(ymd(new Date()).slice(0, 7));
  const range = useMemo(() => {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return { from: `${month}-01`, to: ymd(new Date(y, m, 0)), limit: 100 };
  }, [month]);
  const mine = useApi<Page<Record_>>('/attendance/me', range);
  const items = mine.data?.items ?? [];
  const late = items.filter((r) => r.lateMinutes > 0).length;
  const worked = items.reduce((n, r) => n + r.workedMinutes, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[{ label: 'Days in', value: String(items.length) }, { label: 'Late days', value: String(late) }, { label: 'Hours worked', value: hm(worked) }].map((k) => (
          <Card key={k.label} className="p-4"><p className="text-xs font-semibold uppercase tracking-wide text-muted">{k.label}</p><p className="tabular mt-1 text-2xl font-bold text-brand">{k.value}</p></Card>
        ))}
      </div>
      <Panel title="My attendance" flush actions={<Input type="month" aria-label="Month" value={month} max={ymd(new Date()).slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />}>
        <p className="border-b border-line px-4 py-3 text-xs text-muted">Signing in from the office marks your attendance. There is nothing to press.</p>
        {mine.error ? <div className="p-4"><Notice tone="bad">{mine.error.message}</Notice></div> : mine.loading && !mine.data ? <Spinner /> : <RecordsTable rows={items} />}
      </Panel>
    </div>
  );
}

// -------------------------------------------------------------------- team log

function ExceptionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const people = useApi<Page<{ id: string; name: string; role: { name: string } }>>('/users', { limit: 100, status: 'active' });
  const [userId, setUserId] = useState('');
  const [date, setDate] = useState(ymd(new Date()));
  const [reason, setReason] = useState('');
  const [inTime, setIn] = useState('');
  const [outTime, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/attendance/exceptions', { method: 'POST', body: { userId, date, reason: reason.trim(), ...(inTime && { checkInTime: inTime }), ...(outTime && { checkOutTime: outTime }) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal title="Mark someone present" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <p className="text-xs text-muted">For a day the person could not sign in from the office. It is labelled as an exception in every report and kept in the audit trail.</p>
        <Field label="Person" htmlFor="xp" required error={fe('userId')}><Select id="xp" value={userId} onChange={(e) => setUserId(e.target.value)} required><option value="">Choose a person</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role.name})</option>)}</Select></Field>
        <Field label="Day" htmlFor="xd" required error={fe('date')}><Input id="xd" type="date" value={date} max={ymd(new Date())} onChange={(e) => setDate(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="In at" htmlFor="xi" hint="Shift start if left empty" error={fe('checkInTime')}><Input id="xi" type="time" value={inTime} onChange={(e) => setIn(e.target.value)} /></Field>
          <Field label="Out at" htmlFor="xo" hint="Shift end if left empty" error={fe('checkOutTime')}><Input id="xo" type="time" value={outTime} onChange={(e) => setOut(e.target.value)} /></Field>
        </div>
        <Field label="Reason" htmlFor="xr" required error={fe('reason')}><Textarea id="xr" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Mark present</Button></div>
      </form>
    </Modal>
  );
}

function TeamLog() {
  const { can } = useAuth();
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return ymd(d); });
  const [to, setTo] = useState(ymd(new Date()));
  const [userId, setUserId] = useState('');
  const [method, setMethod] = useState('');
  const [lateOnly, setLateOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const people = useApi<Page<{ id: string; name: string }>>('/users', { limit: 100, status: 'active' });
  const query = useMemo(() => ({ limit: 100, from, to, userId: userId || undefined, method: method || undefined, lateOnly: lateOnly ? 'true' : undefined }), [from, to, userId, method, lateOnly]);
  const log = useApi<Page<Record_>>('/attendance', query);

  return (
    <>
      <Panel title="Attendance log" flush actions={can('attendance.exception') && <Button onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden /> Mark present</Button>}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" /></label>
          <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" /></label>
          <Select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-48"><option value="">Everyone</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Select aria-label="How" value={method} onChange={(e) => setMethod(e.target.value)} className="w-52"><option value="">Every entry</option><option value="office_check">Office sign-in</option><option value="exception">Marked by an admin</option></Select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> Late only</label>
        </div>
        {notice && <div className="p-3 pb-0"><Notice tone="ok">{notice}</Notice></div>}
        {log.error ? <div className="p-4"><Notice tone="bad">{log.error.message}</Notice></div> : log.loading && !log.data ? <Spinner /> : <RecordsTable rows={log.data?.items ?? []} showPerson />}
      </Panel>
      {adding && <ExceptionModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setNotice('Marked present. It shows as an admin entry.'); log.reload(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ day matrix

const CELL: Record<string, { label: string; cls: string }> = {
  P: { label: 'Present', cls: 'bg-ok-50 text-ok' },
  L: { label: 'Late', cls: 'bg-warn-50 text-warn' },
  V: { label: 'On leave', cls: 'bg-info-50 text-info' },
  O: { label: 'Off or holiday', cls: 'bg-head text-subtle' },
  A: { label: 'Absent', cls: 'bg-bad-50 text-bad' },
};

function DayMatrix() {
  const [month, setMonth] = useState(ymd(new Date()).slice(0, 7));
  const report = useApi<Report>('/reports/attendance-days', useMemo(() => ({ month }), [month]));
  const dayCols = report.data?.columns.filter((c) => /^d\d+$/.test(c.key)) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted">Month<Input type="month" value={month} max={ymd(new Date()).slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" /></label>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{Object.entries(CELL).map(([k, v]) => <li key={k} className="flex items-center gap-1.5"><span className={`grid h-5 w-5 place-items-center rounded text-[11px] font-bold ${v.cls}`}>{k}</span>{v.label}</li>)}</ul>
      </div>
      {report.error ? <Notice tone="bad">{report.error.message}</Notice> : !report.data ? <Spinner /> : report.data.rows.length === 0 ? <Card><Empty title="No one to show">People who sign in from the office appear here.</Empty></Card> : (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted">
              <tr><th className="sticky left-0 z-10 bg-head px-4 py-2.5 text-left font-semibold">Name</th>{dayCols.map((c) => <th key={c.key} className="min-w-8 px-1 py-2.5 text-center font-semibold">{c.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.data.rows.map((r) => (
                <tr key={String(r.name)}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-surface px-4 py-2 font-medium">{r.name}<span className="ml-2 text-xs font-normal text-muted">{r.role}</span></td>
                  {dayCols.map((c) => {
                    const v = String(r[c.key] ?? '');
                    return <td key={c.key} className="px-0.5 py-1.5 text-center">{v ? <span title={CELL[v]?.label} className={`mx-auto grid h-7 w-7 place-items-center rounded text-xs font-bold ${CELL[v]?.cls ?? ''}`}>{v}</span> : null}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- settings

interface SettingsView { id: string; effectiveFrom: string; shiftStart: string; shiftEnd: string; graceMinutes: number; halfDayBelowHours: number; idleTimeoutMin: number; weeklyOffDays: number[] }
interface BreakType { id: string; name: string; allowedMinutes: number; isActive: boolean }
interface AttendanceSettings { current: SettingsView | null; upcoming: SettingsView[]; history: SettingsView[]; breakTypes: BreakType[] }
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function BreakForm({ item, onClose, onSaved }: { item?: BreakType; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [mins, setMins] = useState(String(item?.allowedMinutes ?? 30));
  const [active, setActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (item) await api(`/attendance/break-types/${item.id}`, { method: 'PATCH', body: { name: name.trim(), allowedMinutes: Number(mins), isActive: active } });
      else await api('/attendance/break-types', { method: 'POST', body: { name: name.trim(), allowedMinutes: Number(mins) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal title={item ? `Edit ${item.name}` : 'New kind of break'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name" htmlFor="bn" required error={fe('name')}><Input id="bn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Minutes allowed in a day" htmlFor="bm" required error={fe('allowedMinutes')}><Input id="bm" inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} required /></Field>
        {item && <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> In use</label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function SettingsTab() {
  const data = useApi<AttendanceSettings>('/attendance/settings');
  const cur = data.data?.current;
  const [draft, setDraft] = useState<{ shiftStart: string; shiftEnd: string; graceMinutes: string; halfDayBelowHours: string; idleTimeoutMin: string; weeklyOffDays: number[]; effectiveFrom: string } | null>(null);
  const [breakForm, setBreakForm] = useState<BreakType | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const form = draft ?? (cur ? { shiftStart: cur.shiftStart, shiftEnd: cur.shiftEnd, graceMinutes: String(cur.graceMinutes), halfDayBelowHours: String(cur.halfDayBelowHours), idleTimeoutMin: String(cur.idleTimeoutMin), weeklyOffDays: cur.weeklyOffDays, effectiveFrom: ymd(new Date()) } : null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setMsg(null);
    try {
      await api('/attendance/settings', { method: 'PUT', body: { effectiveFrom: form.effectiveFrom, shiftStart: form.shiftStart, shiftEnd: form.shiftEnd, graceMinutes: Number(form.graceMinutes), halfDayBelowHours: Number(form.halfDayBelowHours), idleTimeoutMin: Number(form.idleTimeoutMin), weeklyOffDays: form.weeklyOffDays } });
      setDraft(null);
      data.reload();
      setMsg({ tone: 'ok', text: 'Saved. Earlier days keep the rules they were lived under.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  const set = (k: string, v: string | number[]) => form && setDraft({ ...form, [k]: v });

  if (data.error) return <Notice tone="bad">{data.error.message}</Notice>;
  if (!data.data || !form) return <Spinner />;
  return (
    <div className="space-y-6">
      <Panel title="Shift and rules">
        <form onSubmit={save} className="max-w-3xl space-y-4">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Shift starts" htmlFor="ss"><Input id="ss" type="time" value={form.shiftStart} onChange={(e) => set('shiftStart', e.target.value)} required /></Field>
            <Field label="Shift ends" htmlFor="se"><Input id="se" type="time" value={form.shiftEnd} onChange={(e) => set('shiftEnd', e.target.value)} required /></Field>
            <Field label="Late after (minutes)" htmlFor="sg" hint="Minutes after the shift starts before a sign-in counts as late"><Input id="sg" inputMode="numeric" value={form.graceMinutes} onChange={(e) => set('graceMinutes', e.target.value)} required /></Field>
            <Field label="Half day below (hours)" htmlFor="sh" hint="Fewer worked hours than this makes a half day"><Input id="sh" inputMode="decimal" value={form.halfDayBelowHours} onChange={(e) => set('halfDayBelowHours', e.target.value)} required /></Field>
            <Field label="Sign out after (minutes idle)" htmlFor="si" hint="A break does not pause this"><Input id="si" inputMode="numeric" value={form.idleTimeoutMin} onChange={(e) => set('idleTimeoutMin', e.target.value)} required /></Field>
            <Field label="Starts from" htmlFor="sf" hint="Cannot be a past day"><Input id="sf" type="date" min={ymd(new Date())} value={form.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} required /></Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Weekly offs</legend>
            <div className="flex flex-wrap gap-2">
              {WEEK.map((w, i) => {
                const on = form.weeklyOffDays.includes(i);
                return <button type="button" key={w} aria-pressed={on} onClick={() => set('weeklyOffDays', on ? form.weeklyOffDays.filter((d) => d !== i) : [...form.weeklyOffDays, i])} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${on ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-ink hover:bg-head'}`}>{w}</button>;
              })}
            </div>
          </fieldset>
          <Button type="submit" loading={busy}>Save</Button>
          {data.data.upcoming.length > 0 && <p className="text-xs text-muted">Already booked: {data.data.upcoming.map((u) => `${u.shiftStart} to ${u.shiftEnd} from ${u.effectiveFrom}`).join('; ')}</p>}
        </form>
      </Panel>

      <Panel title="Kinds of break" flush actions={<Button onClick={() => setBreakForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New break</Button>}>
        <ul className="divide-y divide-line">
          {data.data.breakTypes.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="flex items-center gap-2 text-[15px] font-medium">{b.name}<Badge>{b.allowedMinutes} min a day</Badge>{!b.isActive && <Badge tone="warn">Not in use</Badge>}</p>
              <Button size="sm" variant="secondary" onClick={() => setBreakForm(b)}>Edit</Button>
            </li>
          ))}
        </ul>
      </Panel>
      {breakForm && <BreakForm item={breakForm === 'new' ? undefined : breakForm} onClose={() => setBreakForm(null)} onSaved={() => { setBreakForm(null); data.reload(); }} />}
    </div>
  );
}

// --------------------------------------------------------------- location log

interface LocationEntry {
  kind: 'signed_in' | 'refused';
  at: string;
  user: { id: string; name: string } | null;
  ip: string | null;
  position: { lat: number; lng: number; accuracy: number | null } | null;
  result: string | null;
  branch: { id: string; name: string } | null;
  distanceM: number | null;
}

const REFUSED: Record<string, string> = { outside_office: 'Not at the office', device_blocked: 'Phone not approved' };

function LocationLog() {
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return ymd(d); });
  const [to, setTo] = useState(ymd(new Date()));
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState('');
  const people = useApi<Page<{ id: string; name: string }>>('/users', useMemo(() => ({ limit: 100, status: 'active' }), []));
  const log = useApi<LocationEntry[]>('/attendance/location-log', useMemo(() => ({ from, to, userId: userId || undefined, kind: kind || undefined, limit: 300 }), [from, to, userId, kind]));

  return (
    <Panel title="Sign-in places" flush>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">Where people signed in from, and who was turned away at the door. The distance is from the office position set in Settings, Branches.</p>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" /></label>
        <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" /></label>
        <Select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-48"><option value="">Everyone</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select aria-label="Show" value={kind} onChange={(e) => setKind(e.target.value)} className="w-48"><option value="">Signed in and refused</option><option value="signed_in">Signed in</option><option value="refused">Refused</option></Select>
      </div>
      {log.error ? <div className="p-4"><Notice tone="bad">{log.error.message}</Notice></div> : !log.data ? <Spinner /> : log.data.length === 0 ? <Empty title="Nothing in this period" /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2.5 font-semibold">When</th><th className="px-3 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 font-semibold">Result</th><th className="px-3 py-2.5 font-semibold">Network address</th><th className="px-3 py-2.5 font-semibold">Distance from office</th><th className="px-3 py-2.5 font-semibold">Position</th></tr></thead>
            <tbody className="divide-y divide-line">
              {log.data.map((e, i) => (
                <tr key={`${e.at}${i}`} className="hover:bg-mint-50">
                  <td className="whitespace-nowrap px-4 py-3">{fmtDateTime(e.at)}</td>
                  <td className="px-3 py-3 font-medium">{e.user?.name ?? '—'}{e.branch && <span className="block text-xs font-normal text-muted">{e.branch.name}</span>}</td>
                  <td className="px-3 py-3">{e.kind === 'signed_in' ? <Badge tone="ok">Signed in</Badge> : <Badge tone="bad">{REFUSED[e.result ?? ''] ?? 'Refused'}</Badge>}</td>
                  <td className="tabular px-3 py-3 text-muted">{e.ip ?? '—'}</td>
                  <td className="tabular px-3 py-3">{e.distanceM === null ? '—' : e.distanceM >= 1000 ? `${(e.distanceM / 1000).toFixed(1)} km` : `${e.distanceM} m`}</td>
                  <td className="px-3 py-3">{e.position ? <a href={`https://www.openstreetmap.org/?mlat=${e.position.lat}&mlon=${e.position.lng}#map=18/${e.position.lat}/${e.position.lng}`} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">See on map</a> : <span className="text-muted">Not shared</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------------- page

export default function AttendancePage() {
  const { can } = useAuth();
  const tabs = [
    can('attendance.self') && { key: 'mine' as const, label: 'My attendance' },
    can('attendance.read') && { key: 'team' as const, label: 'Team log' },
    can('report.read') && can('attendance.read') && { key: 'days' as const, label: 'By day' },
    can('attendance.read') && { key: 'places' as const, label: 'Sign-in places' },
    can('attendance.settings') && { key: 'settings' as const, label: 'Settings' },
  ].filter(Boolean) as { key: 'mine' | 'team' | 'days' | 'places' | 'settings'; label: string }[];
  const [tab, setTab] = useState<'mine' | 'team' | 'days' | 'places' | 'settings'>(tabs[0]?.key ?? 'mine');
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;

  return (
    <>
      <PageHeader title="Attendance" subtitle="Who is in, from where, and for how long" />
      {tabs.length === 0 ? <Notice tone="warn">Your role does not include attendance.</Notice> : (
        <div className="space-y-4">
          {tabs.length > 1 && <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={tabs} value={active!} onChange={setTab} label="Attendance" /></div>}
          {active === 'mine' && <MyAttendance />}
          {active === 'team' && <TeamLog />}
          {active === 'days' && <DayMatrix />}
          {active === 'places' && <LocationLog />}
          {active === 'settings' && <SettingsTab />}
        </div>
      )}
    </>
  );
}
