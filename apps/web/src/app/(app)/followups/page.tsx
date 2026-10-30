'use client';

import { CalendarDays, Check, ExternalLink, List, PhoneCall, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CalendarView } from '@/components/followups/calendar-view';
import { Badge, Button, Card, Empty, Field, Input, Notice, PageHeader, Select, Spinner, Tabs, Textarea, cx } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtPhone, fromNow } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

type Bucket = 'today' | 'overdue' | 'upcoming' | 'done';

interface FollowUp {
  id: string;
  dueAt: string;
  remindBeforeMin: number;
  note: string | null;
  doneAt: string | null;
  owner: { id: string; name: string };
  lead: { id: string; leadNo: string; name: string; phone: string; status: string; isOpen: boolean };
}
interface Summary { overdue: number; today: number; upcoming: number }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Marks a follow-up done with an optional note, or moves it to a new time. */
function ActionModal({ item, mode, onClose, onDone }: { item: FollowUp; mode: 'done' | 'move'; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(mode === 'move' ? item.note ?? '' : '');
  const [due, setDue] = useState(toLocalInput(item.dueAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'done') await api(`/followups/${item.id}/done`, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} });
      else await api(`/followups/${item.id}`, { method: 'PATCH', body: { dueAt: new Date(due).toISOString(), note: note.trim() || null } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={mode === 'done' ? `Done: ${item.lead.name}` : `Move the follow-up: ${item.lead.name}`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        {mode === 'move' && <Field label="New date and time" htmlFor="fd" required><Input id="fd" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} required /></Field>}
        <Field label={mode === 'done' ? 'How did it go? (optional)' : 'Note'} htmlFor="fn"><Textarea id="fn" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{mode === 'done' ? 'Mark done' : 'Save'}</Button></div>
      </form>
    </Modal>
  );
}

export default function FollowUpsPage() {
  const { can } = useAuth();
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [bucket, setBucket] = useState<Bucket>('today');
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState<{ item: FollowUp; mode: 'done' | 'move' } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const team = useApi<Page<{ id: string; name: string }>>(can('user.read') ? '/users' : null, { limit: 100, status: 'active' });
  const query = useMemo(() => ({ limit: 100, bucket, userId: userId || undefined }), [bucket, userId]);
  const list = useApi<Page<FollowUp>>('/followups', query);
  const summary = useApi<Summary>('/followups/summary', useMemo(() => ({ userId: userId || undefined }), [userId]));

  function refresh() {
    list.reload();
    summary.reload();
  }

  async function call(leadId: string) {
    setNotice(null);
    try {
      await api(`/leads/${leadId}/call`, { method: 'POST', body: {} });
      setNotice({ tone: 'ok', text: 'Calling your phone now. Pick it up and the student will be connected.' });
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  async function remove(f: FollowUp) {
    setNotice(null);
    try {
      await api(`/followups/${f.id}`, { method: 'DELETE' });
      refresh();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  const items = list.data?.items ?? [];
  const tabs = [
    { key: 'today' as const, label: 'Due today', count: summary.data?.today },
    { key: 'overdue' as const, label: 'Overdue', count: summary.data?.overdue },
    { key: 'upcoming' as const, label: 'Upcoming', count: summary.data?.upcoming },
    { key: 'done' as const, label: 'Done' },
  ];

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle="Calls you promised students, grouped by when they are due"
        actions={
          <>
            {team.data && team.data.items.length > 1 && (
              <Select aria-label="Whose follow-ups" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-52"><option value="">Everyone in my scope</option>{team.data.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            )}
            <div role="group" aria-label="View" className="flex rounded-lg border border-line-strong bg-surface p-0.5">
              {([['list', 'List', List], ['calendar', 'Calendar', CalendarDays]] as const).map(([k, label, Icon]) => (
                <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)} className={cx('flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium', view === k ? 'bg-brand text-white' : 'text-muted hover:text-ink')}><Icon className="h-4 w-4" aria-hidden />{label}</button>
              ))}
            </div>
          </>
        }
      />
      {notice && <div className="mb-4"><Notice tone={notice.tone}>{notice.text}</Notice></div>}
      {view === 'calendar' ? <CalendarView userId={userId} /> : (
      <Card className="overflow-hidden">
        <Tabs tabs={tabs} value={bucket} onChange={setBucket} label="Follow-up groups" />
        {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : list.loading && !list.data ? <Spinner /> : items.length === 0 ? (
          <Empty title={bucket === 'done' ? 'Nothing finished yet' : 'Nothing here'}>{bucket === 'overdue' ? 'No follow-up is late. Well done.' : bucket === 'today' ? 'No follow-up is due today.' : bucket === 'upcoming' ? 'No follow-up is booked for later.' : 'Finished follow-ups will be listed here.'}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2.5 font-semibold">Lead</th><th className="px-3 py-2.5 font-semibold">Status</th><th className="px-3 py-2.5 font-semibold">{bucket === 'done' ? 'Was due' : 'Due'}</th><th className="px-3 py-2.5 font-semibold">With</th><th className="px-3 py-2.5 font-semibold">Note</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((f) => (
                  <tr key={f.id} className="hover:bg-mint-50">
                    <td className="px-4 py-3"><Link href={`/leads/${f.lead.id}`} className="font-medium text-ink hover:text-brand-600">{f.lead.name}</Link><p className="tabular text-xs text-muted">{fmtPhone(f.lead.phone)} · #{f.lead.leadNo}</p></td>
                    <td className="px-3 py-3"><Badge tone="brand">{f.lead.status}</Badge></td>
                    <td className="px-3 py-3"><span className={bucket === 'overdue' ? 'font-medium text-bad' : ''}>{fmtDateTime(f.dueAt)}</span><p className="text-xs text-muted">{f.doneAt ? `Done ${fromNow(f.doneAt)}` : fromNow(f.dueAt)}</p></td>
                    <td className="px-3 py-3 text-muted">{f.owner.name}</td>
                    <td className="max-w-64 truncate px-3 py-3 text-muted" title={f.note ?? ''}>{f.note ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {!f.doneAt && can('call.place') && f.lead.isOpen && <button onClick={() => void call(f.lead.id)} aria-label={`Call ${f.lead.name}`} title="Call" className="grid h-9 w-9 place-items-center rounded-lg text-info hover:bg-info-50"><PhoneCall className="h-5 w-5" /></button>}
                        {!f.doneAt && <button onClick={() => setAction({ item: f, mode: 'done' })} aria-label="Mark done" title="Mark done" className="grid h-9 w-9 place-items-center rounded-lg text-ok hover:bg-ok-50"><Check className="h-5 w-5" /></button>}
                        {!f.doneAt && <button onClick={() => setAction({ item: f, mode: 'move' })} aria-label="Move to another time" title="Move to another time" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><Pencil className="h-[18px] w-[18px]" /></button>}
                        <Link href={`/leads/${f.lead.id}`} aria-label={`Open ${f.lead.name}`} title="Open lead" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head hover:text-ink"><ExternalLink className="h-[18px] w-[18px]" /></Link>
                        {!f.doneAt && <button onClick={() => void remove(f)} aria-label="Delete follow-up" title="Delete" className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-bad-50 hover:text-bad"><Trash2 className="h-[18px] w-[18px]" /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      )}
      {action && <ActionModal item={action.item} mode={action.mode} onClose={() => setAction(null)} onDone={() => { setAction(null); refresh(); }} />}
    </>
  );
}
