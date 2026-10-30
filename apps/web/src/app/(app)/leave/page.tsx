'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Panel, Select, Spinner, Tabs, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

type Status = 'pending' | 'approved' | 'rejected' | 'cancelled';
interface LeaveType { id: string; name: string; isPaid: boolean; yearlyQuota: number; isActive: boolean }
interface LeaveRequest {
  id: string;
  user: { id: string; name: string };
  leaveType: { id: string; name: string; isPaid: boolean };
  fromDate: string;
  toDate: string;
  days: number;
  reason: string | null;
  status: Status;
  decidedBy: string | null;
  decisionNote: string | null;
}
interface Balances { year: number; balances: { leaveType: { id: string; name: string; isPaid: boolean }; yearlyQuota: number; remaining: number; pending: number; available: number | null }[] }
interface Holiday { id: string; date: string; name: string }

const STATUS: Record<Status, { label: string; tone: 'warn' | 'ok' | 'bad' | 'neutral' }> = { pending: { label: 'Waiting', tone: 'warn' }, approved: { label: 'Approved', tone: 'ok' }, rejected: { label: 'Turned down', tone: 'bad' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const ymd = (d: Date) => d.toLocaleDateString('en-CA');
const nice = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const span = (r: LeaveRequest) => (r.fromDate === r.toDate ? nice(r.fromDate) : `${nice(r.fromDate)} to ${nice(r.toDate)}`);
const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

function RequestsTable({ rows, showPerson, actions }: { rows: LeaveRequest[]; showPerson?: boolean; actions?: (r: LeaveRequest) => React.ReactNode }) {
  if (rows.length === 0) return <Empty title="No leave requests" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-head text-xs uppercase tracking-wide text-muted">
          <tr>{showPerson && <th className="px-4 py-2.5 font-semibold">Person</th>}<th className={`${showPerson ? 'px-3' : 'px-4'} py-2.5 font-semibold`}>Leave</th><th className="px-3 py-2.5 font-semibold">Dates</th><th className="px-3 py-2.5 font-semibold">Reason</th><th className="px-3 py-2.5 font-semibold">Status</th>{actions && <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-mint-50">
              {showPerson && <td className="px-4 py-3 font-medium">{r.user.name}</td>}
              <td className={`${showPerson ? 'px-3' : 'px-4'} py-3`}>{r.leaveType.name}{!r.leaveType.isPaid && <span className="ml-1.5 text-xs text-muted">(unpaid)</span>}</td>
              <td className="px-3 py-3">{span(r)}<span className="block text-xs text-muted">{days(r.days)}</span></td>
              <td className="max-w-64 truncate px-3 py-3 text-muted" title={r.reason ?? ''}>{r.reason ?? '—'}</td>
              <td className="px-3 py-3"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.decisionNote && <span className="block text-xs text-muted" title={r.decisionNote}>{r.decidedBy ? `${r.decidedBy}: ` : ''}{r.decisionNote}</span>}</td>
              {actions && <td className="px-4 py-3"><div className="flex justify-end gap-2">{actions(r)}</div></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- my leave

function RequestForm({ types, onClose, onSaved }: { types: LeaveType[]; onClose: () => void; onSaved: () => void }) {
  const [typeId, setTypeId] = useState('');
  const [from, setFrom] = useState(ymd(new Date()));
  const [to, setTo] = useState('');
  const [half, setHalf] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/leave/requests', { method: 'POST', body: { leaveTypeId: typeId, fromDate: from, ...(to && !half && { toDate: to }), halfDay: half, ...(reason.trim() && { reason: reason.trim() }) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal title="Apply for leave" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Kind of leave" htmlFor="lt" required error={fe('leaveTypeId')}><Select id="lt" value={typeId} onChange={(e) => setTypeId(e.target.value)} required><option value="">Choose</option>{types.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? '' : ' (unpaid)'}</option>)}</Select></Field>
        <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> Half day</label>
        <div className="grid grid-cols-2 gap-4">
          <Field label={half ? 'Day' : 'From'} htmlFor="lf" required error={fe('fromDate')}><Input id="lf" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
          {!half && <Field label="To" htmlFor="ll" hint="Leave empty for one day" error={fe('toDate')}><Input id="ll" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></Field>}
        </div>
        <Field label="Reason" htmlFor="lr" error={fe('reason')}><Textarea id="lr" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Send request</Button></div>
      </form>
    </Modal>
  );
}

function MyLeave() {
  const types = useApi<LeaveType[]>('/leave/types');
  const bal = useApi<Balances>('/leave/balances');
  const mine = useApi<Page<LeaveRequest>>('/leave/requests/mine', useMemo(() => ({ limit: 100 }), []));
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function cancel(r: LeaveRequest) {
    setNotice(null);
    try {
      await api(`/leave/requests/${r.id}/cancel`, { method: 'POST', body: {} });
      mine.reload();
      bal.reload();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }
  return (
    <div className="space-y-4">
      {bal.data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bal.data.balances.map((b) => {
            const used = b.yearlyQuota - b.remaining;
            const pct = b.yearlyQuota > 0 ? Math.min(100, Math.round((used / b.yearlyQuota) * 100)) : 0;
            return (
              <Card key={b.leaveType.id} className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{b.leaveType.name}</p>
                {b.leaveType.isPaid ? (
                  <>
                    <p className="tabular mt-1 text-2xl font-bold text-brand">{b.remaining}<span className="text-sm font-medium text-muted"> of {b.yearlyQuota} left</span></p>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-head" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${b.leaveType.name} used`}><div className="h-full rounded-full bg-teal-600" style={{ width: `${pct}%` }} /></div>
                    {b.pending > 0 && <p className="mt-1.5 text-xs text-warn">{days(b.pending)} waiting for approval</p>}
                  </>
                ) : <p className="mt-1 text-sm text-muted">Unpaid. There is no limit to track.</p>}
              </Card>
            );
          })}
        </div>
      )}
      <Panel title="My leave requests" flush actions={<Button onClick={() => setAdding(true)} disabled={!types.data}><Plus className="h-3.5 w-3.5" aria-hidden /> Apply for leave</Button>}>
        {notice && <div className="p-3 pb-0"><Notice tone={notice.tone}>{notice.text}</Notice></div>}
        {mine.error ? <div className="p-4"><Notice tone="bad">{mine.error.message}</Notice></div> : !mine.data ? <Spinner /> : (
          <RequestsTable rows={mine.data.items} actions={(r) => (r.status === 'pending' || (r.status === 'approved' && r.toDate >= ymd(new Date()))) && <Button size="sm" variant="secondary" onClick={() => void cancel(r)}>Cancel</Button>} />
        )}
      </Panel>
      {adding && types.data && <RequestForm types={types.data} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); mine.reload(); bal.reload(); setNotice({ tone: 'ok', text: 'Your request was sent for approval.' }); }} />}
    </div>
  );
}

// --------------------------------------------------------------- approvals

function DecisionModal({ request, onClose, onSaved }: { request: LeaveRequest; onClose: () => void; onSaved: () => void }) {
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/leave/requests/${request.id}/decision`, { method: 'POST', body: { decision, ...(note.trim() && { note: note.trim() }) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal title={`${request.user.name}: ${request.leaveType.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <p className="text-sm text-muted">{span(request)} · {days(request.days)}{request.reason ? ` · ${request.reason}` : ''}</p>
        <div role="radiogroup" aria-label="Decision" className="grid grid-cols-2 gap-2">
          {(['approved', 'rejected'] as const).map((d) => <button type="button" role="radio" aria-checked={decision === d} key={d} onClick={() => setDecision(d)} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${decision === d ? (d === 'approved' ? 'border-ok bg-ok-50 text-ok' : 'border-bad bg-bad-50 text-bad') : 'border-line-strong text-muted hover:bg-head'}`}>{d === 'approved' ? 'Approve' : 'Turn down'}</button>)}
        </div>
        <Field label={decision === 'rejected' ? 'Reason (required)' : 'Note (optional)'} htmlFor="dn" error={error?.fieldErrors.find((f) => f.field === 'note')?.message}><Textarea id="dn" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} required={decision === 'rejected'} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save decision</Button></div>
      </form>
    </Modal>
  );
}

function Approvals() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'' | Status>('pending');
  const list = useApi<Page<LeaveRequest>>('/leave/requests', useMemo(() => ({ limit: 100, status: status || undefined }), [status]));
  const [deciding, setDeciding] = useState<LeaveRequest | null>(null);
  return (
    <>
      <Panel title="Leave requests" flush actions={<Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | Status)} className="w-44"><option value="">All</option>{(Object.keys(STATUS) as Status[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}</Select>}>
        {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : !list.data ? <Spinner /> : (
          <RequestsTable rows={list.data.items} showPerson actions={can('leave.approve') ? (r) => r.status === 'pending' && <Button size="sm" onClick={() => setDeciding(r)}>Decide</Button> : undefined} />
        )}
      </Panel>
      {deciding && <DecisionModal request={deciding} onClose={() => setDeciding(null)} onSaved={() => { setDeciding(null); list.reload(); }} />}
    </>
  );
}

// ---------------------------------------------------------------- settings

function TypeForm({ item, onClose, onSaved }: { item?: LeaveType; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [paid, setPaid] = useState(item?.isPaid ?? true);
  const [quota, setQuota] = useState(String(item?.yearlyQuota ?? 12));
  const [active, setActive] = useState(item?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), isPaid: paid, yearlyQuota: paid ? Number(quota) : 0 };
      if (item) await api(`/leave/types/${item.id}`, { method: 'PATCH', body: { ...body, isActive: active } });
      else await api('/leave/types', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }
  return (
    <Modal title={item ? `Edit ${item.name}` : 'New kind of leave'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name" htmlFor="tn" required error={fe('name')}><Input id="tn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> Paid leave, counted against a yearly balance</label>
        {paid && <Field label="Days each person gets every year" htmlFor="tq" hint="Half days are allowed, for example 7.5" error={fe('yearlyQuota')}><Input id="tq" inputMode="decimal" value={quota} onChange={(e) => setQuota(e.target.value)} required /></Field>}
        {item && <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> In use</label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Save</Button></div>
      </form>
    </Modal>
  );
}

function Holidays() {
  const [year, setYear] = useState(new Date().getFullYear());
  const list = useApi<Holiday[]>('/holidays', useMemo(() => ({ year }), [year]));
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/holidays', { method: 'POST', body: { date, name: name.trim() } });
      setDate('');
      setName('');
      list.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove(h: Holiday) {
    setError(null);
    try { await api(`/holidays/${h.id}`, { method: 'DELETE' }); list.reload(); } catch (err) { setError(errorText(err)); }
  }
  return (
    <Panel title="Holidays" flush actions={<Select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">{[-1, 0, 1].map((o) => <option key={o} value={new Date().getFullYear() + o}>{new Date().getFullYear() + o}</option>)}</Select>}>
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <Input type="date" aria-label="Holiday date" value={date} min={`${year}-01-01`} max={`${year}-12-31`} onChange={(e) => setDate(e.target.value)} required className="w-44" />
        <Input aria-label="Holiday name" placeholder="Name, for example Diwali" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} className="w-64" />
        <Button type="submit" loading={busy}><Plus className="h-3.5 w-3.5" aria-hidden /> Add holiday</Button>
      </form>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : !list.data ? <Spinner /> : list.data.length === 0 ? <Empty title={`No holidays added for ${year}`} /> : (
        <ul className="divide-y divide-line">
          {list.data.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-3"><span className="text-sm"><span className="tabular inline-block w-32 font-medium">{nice(h.date)}</span>{h.name}</span><button onClick={() => void remove(h)} aria-label={`Remove ${h.name}`} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-bad-50 hover:text-bad"><Trash2 className="h-[18px] w-[18px]" /></button></li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LeaveSettings() {
  const types = useApi<LeaveType[]>('/leave/types');
  const [form, setForm] = useState<LeaveType | 'new' | null>(null);
  return (
    <div className="space-y-6">
      <Panel title="Kinds of leave" flush actions={<Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> New leave type</Button>}>
        {types.error ? <div className="p-4"><Notice tone="bad">{types.error.message}</Notice></div> : !types.data ? <Spinner /> : (
          <ul className="divide-y divide-line">
            {types.data.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">{t.name}<Badge tone={t.isPaid ? 'ok' : 'neutral'}>{t.isPaid ? `${t.yearlyQuota} days a year` : 'Unpaid'}</Badge>{!t.isActive && <Badge tone="warn">Not in use</Badge>}</p>
                <Button size="sm" variant="secondary" onClick={() => setForm(t)}>Edit</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Holidays />
      {form && <TypeForm item={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); types.reload(); }} />}
    </div>
  );
}

// -------------------------------------------------------------------- page

export default function LeavePage() {
  const { can } = useAuth();
  const tabs = [
    can('leave.request') && { key: 'mine' as const, label: 'My leave' },
    can('leave.read') && { key: 'approvals' as const, label: 'Requests' },
    can('leave.settings') && { key: 'settings' as const, label: 'Types and holidays' },
  ].filter(Boolean) as { key: 'mine' | 'approvals' | 'settings'; label: string }[];
  const [tab, setTab] = useState<'mine' | 'approvals' | 'settings'>(tabs[0]?.key ?? 'mine');
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;
  return (
    <>
      <PageHeader title="Leave" subtitle="Apply, approve and keep track of balances and holidays" />
      {tabs.length === 0 ? <Notice tone="warn">Your role does not include leave.</Notice> : (
        <div className="space-y-4">
          {tabs.length > 1 && <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={tabs} value={active!} onChange={setTab} label="Leave" /></div>}
          {active === 'mine' && <MyLeave />}
          {active === 'approvals' && <Approvals />}
          {active === 'settings' && <LeaveSettings />}
        </div>
      )}
    </>
  );
}
