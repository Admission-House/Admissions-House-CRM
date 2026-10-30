'use client';

import { Pause, Phone, Play, SkipForward, Square } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Notice, PageHeader, Panel, Select, Spinner } from '@/components/ui';
import { WrapUp, type Call } from '@/components/leads/calls-tab';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime, fmtPhone } from '@/lib/format';
import type { LeadListItem, Page, Queues } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface DialerLead { leadId: string; leadNo: string; name: string; phone: string; state: 'pending' | 'called' | 'skipped' }
interface Session {
  id: string;
  status: 'running' | 'paused' | 'stopped' | 'finished';
  user: { id: string; name: string };
  startedAt: string;
  endedAt: string | null;
  counts: { total: number; pending: number; called: number; skipped: number };
  current: DialerLead | null;
  leads?: DialerLead[];
}

const QUEUE_LABEL: Record<string, string> = { fresh: 'Fresh leads', missed: 'Missed leads', followup: 'Follow-up leads', counselled: 'Counselled leads', fee_paid: 'Application fee paid' };
const STATE: Record<DialerLead['state'], { label: string; tone: 'neutral' | 'ok' | 'warn' }> = { pending: { label: 'Waiting', tone: 'neutral' }, called: { label: 'Called', tone: 'ok' }, skipped: { label: 'Skipped', tone: 'warn' } };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/** Choose which leads to load into a new session. */
function StartPanel({ onStarted }: { onStarted: () => void }) {
  const queues = useApi<Queues>('/leads/queues');
  const [queue, setQueue] = useState('fresh');
  const params = useMemo(() => ({ queue, assignedTo: 'me', limit: 100, sort: 'newest' }), [queue]);
  const leads = useApi<Page<LeadListItem>>('/leads', params);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialable = (leads.data?.items ?? []).filter((l) => l.status.isOpen);
  const chosen = dialable.filter((l) => picked[l.id] ?? true);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await api('/dialer/sessions', { method: 'POST', body: { leadIds: chosen.map((l) => l.id) } });
      onStarted();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Panel title="Start a dialing session" flush>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <Select aria-label="Which leads" value={queue} onChange={(e) => { setQueue(e.target.value); setPicked({}); }} className="w-64">
          {Object.entries(QUEUE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}{queues.data ? ` (${queues.data.queues[k] ?? 0})` : ''}</option>)}
        </Select>
        <p className="text-sm text-muted">{chosen.length} of {dialable.length} leads selected. They are called one after another, in this order.</p>
        <Button className="ml-auto" disabled={chosen.length === 0} loading={busy} onClick={() => void start()}><Play className="h-4 w-4" aria-hidden /> Start dialing</Button>
      </div>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {leads.error ? <div className="p-4"><Notice tone="bad">{leads.error.message}</Notice></div> : leads.loading && !leads.data ? <Spinner /> : dialable.length === 0 ? <Empty title="No leads to dial here">There is nothing in this list that is assigned to you and still open.</Empty> : (
        <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
          {dialable.map((l) => (
            <li key={l.id}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-mint-50">
                <input type="checkbox" checked={picked[l.id] ?? true} onChange={(e) => setPicked((p) => ({ ...p, [l.id]: e.target.checked }))} className="h-4 w-4 accent-[#0f625e]" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{l.name}</span><span className="tabular text-xs text-muted">{fmtPhone(l.phone)} · #{l.leadNo}</span></span>
                <Badge tone="brand">{l.status.name}</Badge>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The running session: the lead in line, the controls, and the list. */
function SessionPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [wrapping, setWrapping] = useState<Call | null>(null);
  const done = session.counts.called + session.counts.skipped;
  const percent = session.counts.total ? Math.round((done / session.counts.total) * 100) : 0;
  const paused = session.status === 'paused';

  async function act(name: 'dial' | 'skip' | 'pause' | 'resume' | 'stop') {
    setBusy(name);
    setNotice(null);
    try {
      await api(`/dialer/sessions/${session.id}/${name}`, { method: 'POST', body: {} });
      if (name === 'dial') setNotice({ tone: 'ok', text: 'Calling your phone now. Pick it up and the student will be connected. When the call ends, fill in the after-call form.' });
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WRAP_UP_REQUIRED' && typeof e.details?.callId === 'string') {
        try {
          setWrapping(await api<Call>(`/calls/${e.details.callId}`));
          setNotice({ tone: 'bad', text: e.message });
        } catch (inner) {
          setNotice({ tone: 'bad', text: errorText(inner) });
        }
      } else {
        setNotice({ tone: 'bad', text: errorText(e) });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{paused ? 'Paused' : 'Next in line'}</p>
            {session.current ? (
              <>
                <Link href={`/leads/${session.current.leadId}`} className="mt-1 block text-2xl font-bold text-brand hover:underline">{session.current.name}</Link>
                <p className="tabular mt-1 text-base text-muted">{fmtPhone(session.current.phone)} · #{session.current.leadNo}</p>
              </>
            ) : <p className="mt-1 text-xl font-semibold text-ink">Everyone has been called</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {paused ? (
              <Button variant="accent" loading={busy === 'resume'} onClick={() => void act('resume')}><Play className="h-4 w-4" aria-hidden /> Resume</Button>
            ) : (
              <>
                <Button disabled={!session.current} loading={busy === 'dial'} onClick={() => void act('dial')}><Phone className="h-4 w-4" aria-hidden /> Call now</Button>
                <Button variant="secondary" disabled={!session.current} loading={busy === 'skip'} onClick={() => void act('skip')}><SkipForward className="h-4 w-4" aria-hidden /> Skip</Button>
                <Button variant="secondary" loading={busy === 'pause'} onClick={() => void act('pause')}><Pause className="h-4 w-4" aria-hidden /> Pause</Button>
              </>
            )}
            <Button variant="danger" loading={busy === 'stop'} onClick={() => void act('stop')}><Square className="h-4 w-4" aria-hidden /> End session</Button>
          </div>
        </div>
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm"><span className="font-medium">{done} of {session.counts.total} done</span><span className="text-muted">{session.counts.called} called · {session.counts.skipped} skipped · {session.counts.pending} waiting</span></div>
          <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-head" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Session progress"><div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${percent}%` }} /></div>
        </div>
      </Card>

      <Panel title="Leads in this session" flush>
        <ul className="max-h-[26rem] divide-y divide-line overflow-y-auto">
          {(session.leads ?? []).map((l, i) => (
            <li key={l.leadId} className={`flex items-center gap-3 px-4 py-2.5 ${session.current?.leadId === l.leadId ? 'bg-mint-50' : ''}`}>
              <span className="tabular w-6 text-xs text-subtle">{i + 1}</span>
              <Link href={`/leads/${l.leadId}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-brand-600">{l.name}<span className="tabular ml-2 text-xs font-normal text-muted">{fmtPhone(l.phone)}</span></Link>
              <Badge tone={STATE[l.state].tone}>{STATE[l.state].label}</Badge>
            </li>
          ))}
        </ul>
      </Panel>
      {wrapping && <WrapUp call={wrapping} onClose={() => setWrapping(null)} onDone={() => { setWrapping(null); setNotice(null); onChange(); }} />}
    </div>
  );
}

export default function DialerPage() {
  const current = useApi<Session | null>('/dialer/sessions/current');
  const past = useApi<Session[]>('/dialer/sessions', useMemo(() => ({ limit: 10 }), []));

  return (
    <>
      <PageHeader title="Auto dialer" subtitle="Load a list of leads and call them one after another" />
      {current.error ? <Notice tone="bad">{current.error.message}</Notice> : current.loading && current.data === undefined ? <Spinner /> : current.data ? (
        <SessionPanel session={current.data} onChange={() => { current.reload(); past.reload(); }} />
      ) : (
        <div className="space-y-6">
          <StartPanel onStarted={() => { current.reload(); past.reload(); }} />
          {(past.data?.length ?? 0) > 0 && (
            <Panel title="Earlier sessions" flush>
              <ul className="divide-y divide-line">
                {past.data!.filter((s) => s.status !== 'running' && s.status !== 'paused').map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <span><span className="font-medium">{fmtDateTime(s.startedAt)}</span><span className="ml-2 text-muted">{s.user.name}</span></span>
                    <span className="text-muted">{s.counts.called} called · {s.counts.skipped} skipped · {s.counts.pending} not reached <Badge className="ml-2">{s.status === 'finished' ? 'Finished' : 'Ended early'}</Badge></span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
