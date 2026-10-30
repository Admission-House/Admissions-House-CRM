'use client';

import { Check, CircleDot, FileText, MessageSquare, PhoneCall, RefreshCw, Repeat, UserCheck, CalendarClock, Clock } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, Textarea, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fromNow } from '@/lib/format';
import type { Page, StatusOption, UserOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export interface LeadDetail {
  id: string;
  leadNo: string;
  name: string;
  phone: string;
  email: string | null;
  intent: 'hot' | 'warm' | 'cold' | null;
  studyMode: 'online' | 'regular' | null;
  expectedClosureOn: string | null;
  interestNote: string | null;
  status: { id: string; name: string; queue: string; isOpen: boolean; requiresFollowup: boolean };
  substatus: { id: string; name: string } | null;
  source: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  assignedAt: string | null;
  nextFollowupAt: string | null;
  firstCalledAt: string | null;
  openFollowUps: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  extraPhones: { phone: string; label: string }[];
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/** datetime-local gives "2026-11-03T15:30" in the viewer's zone; the API wants a full timestamp with offset. */
const toIso = (local: string) => new Date(local).toISOString();
const minLocal = () => {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// ---------------------------------------------------------------- status

export function StatusPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [statusId, setStatusId] = useState('');
  const [substatusId, setSubstatusId] = useState('');
  const [remark, setRemark] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const options = statuses.data?.filter((s) => s.isActive !== false) ?? [];
  const chosen = options.find((s) => s.id === (statusId || lead.status.id));
  const changing = !!statusId && statusId !== lead.status.id;
  const needsDate = !!chosen && chosen.isOpen && chosen.requiresFollowup && (changing || lead.openFollowUps === 0) && lead.openFollowUps === 0;

  if (!can('lead.update')) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/leads/${lead.id}/status`, {
        method: 'POST',
        body: {
          statusId: statusId || lead.status.id,
          ...(substatusId && { substatusId }),
          ...(remark.trim() && { remark: remark.trim() }),
          ...(due && can('followup.manage') && { followUp: { dueAt: toIso(due) } }),
        },
      });
      setRemark('');
      setDue('');
      setStatusId('');
      setSubstatusId('');
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">Update status</h2>
      <form onSubmit={save} className="mt-4 space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        {saved && <Notice tone="ok">Saved.</Notice>}
        <Field label="Status" htmlFor="st">
          <Select id="st" value={statusId || lead.status.id} onChange={(e) => { setStatusId(e.target.value); setSubstatusId(''); }}>
            {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {chosen?.substatuses && chosen.substatuses.length > 0 && (
          <Field label="Sub-status" htmlFor="sub">
            <Select id="sub" value={substatusId} onChange={(e) => setSubstatusId(e.target.value)}>
              <option value="">None</option>
              {chosen.substatuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        {can('followup.manage') && chosen?.isOpen && (
          <Field label={needsDate ? 'Next follow-up (required)' : 'Next follow-up (optional)'} htmlFor="due">
            <Input id="due" type="datetime-local" min={minLocal()} value={due} onChange={(e) => setDue(e.target.value)} required={needsDate} />
          </Field>
        )}
        <Field label="Remark" htmlFor="rm"><Textarea id="rm" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={1000} placeholder="What was discussed?" /></Field>
        <Button type="submit" loading={busy} className="w-full">Save</Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- assign

export function AssignPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const people = useApi<Page<UserOption>>(can('lead.assign') && can('user.read') ? '/users' : null, { limit: 100, status: 'active' });
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The chosen person is absent, on leave or on a break: the Admin may still hand the lead over.
  const [unavailable, setUnavailable] = useState(false);

  if (!can('lead.assign')) return null;

  async function assign(anyway = false) {
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      await api(`/leads/${lead.id}/assign`, { method: 'POST', body: { userId: userId === 'none' ? null : userId, ...(anyway && { allowUnavailable: true }) } });
      setUserId('');
      onChanged();
    } catch (e) {
      setUnavailable(e instanceof ApiError && e.code === 'ASSIGNEE_UNAVAILABLE');
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink">Assigned to</h2>
      <p className="mt-1 text-sm text-muted">{lead.assignedTo ? `${lead.assignedTo.name}${lead.assignedAt ? `, ${fromNow(lead.assignedAt)}` : ''}` : 'Nobody yet'}</p>
      {error && (
        <div className="mt-3">
          <Notice tone="bad">
            {error}
            {unavailable && <> <button type="button" className="font-semibold underline" onClick={() => void assign(true)}>Assign anyway</button></>}
          </Notice>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Select aria-label="Hand over to" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person</option>
          <option value="none">Move to the unassigned pool</option>
          {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Button variant="secondary" onClick={() => void assign()} disabled={!userId} loading={busy}>Assign</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------- follow-ups

interface FollowUp {
  id: string;
  dueAt: string;
  note: string | null;
  doneAt: string | null;
  owner: { id: string; name: string };
}

export function FollowUpsPanel({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const list = useApi<FollowUp[]>(`/leads/${lead.id}/followups`);
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/followups`, { method: 'POST', body: { dueAt: toIso(due), ...(note.trim() && { note: note.trim() }) } });
      setDue('');
      setNote('');
      list.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function done(id: string) {
    try {
      await api(`/followups/${id}/done`, { method: 'POST', body: {} });
      list.reload();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const items = list.data ?? [];
  return (
    <Card>
      <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-semibold text-ink">Follow-ups</h2></div>
      {can('followup.manage') && lead.status.isOpen && (
        <form onSubmit={add} className="grid gap-3 border-b border-line p-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
          <Input aria-label="When" type="datetime-local" min={minLocal()} value={due} onChange={(e) => setDue(e.target.value)} required />
          <Input aria-label="Note" placeholder="What to do (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <Button type="submit" loading={busy}>Add</Button>
        </form>
      )}
      {error && <div className="p-5 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.loading && !list.data ? <Spinner /> : items.length === 0 ? <Empty title="No follow-ups yet" /> : (
        <ul className="divide-y divide-line">
          {items.map((f) => {
            const late = !f.doneAt && new Date(f.dueAt) < new Date();
            return (
              <li key={f.id} className="flex items-start justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className={cx('text-sm font-medium', late ? 'text-bad' : 'text-ink')}>{fmtDateTime(f.dueAt)} <span className="font-normal text-muted">· {fromNow(f.dueAt)}</span></p>
                  {f.note && <p className="mt-0.5 text-sm text-muted">{f.note}</p>}
                  <p className="mt-0.5 text-xs text-subtle">{f.owner.name}</p>
                </div>
                {f.doneAt ? <Badge tone="ok">Done</Badge> : can('followup.manage') ? (
                  <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => void done(f.id)}><Check className="h-3.5 w-3.5" aria-hidden /> Mark done</Button>
                ) : <Badge tone={late ? 'bad' : 'info'}>{late ? 'Overdue' : 'Open'}</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// --------------------------------------------------------------- timeline

interface Activity {
  id: string;
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  remark: string | null;
  user: { id: string; name: string } | null;
  createdAt: string;
}

const ICON: Record<string, typeof CircleDot> = {
  note: MessageSquare, status_change: RefreshCw, assignment: UserCheck, call: PhoneCall, document: FileText, shortlist: Check,
  enquiry: Repeat, field_change: CircleDot, followup: CalendarClock,
};

function describe(a: Activity): string {
  switch (a.type) {
    case 'status_change':
      return `Status changed${a.oldValue ? ` from ${a.oldValue}` : ''}${a.newValue ? ` to ${a.newValue}` : ''}`;
    case 'followup':
      return a.newValue ? `Follow-up set for ${fmtDateTime(a.newValue)}` : 'Follow-up updated';
    case 'field_change':
      return `${a.field ?? 'A detail'} changed${a.oldValue ? ` from ${a.oldValue}` : ''}${a.newValue ? ` to ${a.newValue}` : ''}`;
    case 'document':
      return `${a.remark ?? 'Document'}: ${a.field ?? ''} ${a.newValue ?? a.oldValue ?? ''}`.trim();
    default:
      return a.remark ?? a.type;
  }
}

export function Timeline({ lead }: { lead: LeadDetail }) {
  const { can } = useAuth();
  const [pages, setPages] = useState<Activity[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useApi<Page<Activity>>(`/leads/${lead.id}/activities`, { limit: 30 });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = [...(first.data?.items ?? []), ...pages];
  const cursor = pages.length > 0 ? next : (first.data?.nextCursor ?? null);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${lead.id}/notes`, { method: 'POST', body: { remark: note.trim() } });
      setNote('');
      setPages([]);
      first.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function showMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const p = await api<Page<Activity>>(`/leads/${lead.id}/activities`, { query: { limit: 30, cursor } });
      setPages((prev) => [...prev, ...p.items]);
      setNext(p.nextCursor);
    } finally {
      setMore(false);
    }
  }

  return (
    <Card>
      <div className="border-b border-line px-4 py-3"><h2 className="text-sm font-semibold text-ink">History</h2></div>
      {can('lead.update') && (
        <form onSubmit={addNote} className="space-y-3 border-b border-line p-5">
          {error && <Notice tone="bad">{error}</Notice>}
          <Textarea aria-label="Add a note" placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required />
          <div className="flex justify-end"><Button type="submit" loading={busy} disabled={!note.trim()}>Add note</Button></div>
        </form>
      )}
      {first.loading && !first.data ? <Spinner /> : items.length === 0 ? <Empty title="Nothing here yet" /> : (
        <ol className="relative space-y-5 p-5">
          <span className="absolute bottom-6 left-[2.15rem] top-6 w-px bg-line" aria-hidden />
          {items.map((a) => {
            const Icon = ICON[a.type] ?? Clock;
            return (
              <li key={a.id} className="relative flex gap-4">
                <span className="relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-mint text-brand ring-4 ring-surface"><Icon className="h-4 w-4" aria-hidden /></span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm text-ink">{describe(a)}</p>
                  {a.type === 'status_change' && a.remark && <p className="mt-1 rounded-lg bg-canvas px-3 py-2 text-sm text-muted">{a.remark}</p>}
                  <p className="mt-1 text-xs text-subtle">{a.user?.name ?? 'System'} · {fmtDateTime(a.createdAt)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {cursor && <div className="flex justify-center border-t border-line p-4"><Button variant="secondary" loading={more} onClick={() => void showMore()}>Show older</Button></div>}
    </Card>
  );
}
