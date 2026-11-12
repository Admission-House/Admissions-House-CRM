'use client';

import { Mic, Phone, Plus, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CallColleagueModal, NewMeetingModal, SessionDetailModal } from '@/components/communications/session-modals';
import { Badge, Button, Card, Empty, Input, PageHeader, Select, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { OUTCOME_TEXT, PHASE_TEXT, fmtDuration, type HistoryItem } from '@/lib/communications';
import { fmtDateTime } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { useApi } from '@/lib/use-api';

interface Page { items: HistoryItem[]; nextCursor: string | null }

const tone = (i: HistoryItem) => (i.phase !== 'ended' ? 'brand' : i.outcome === 'completed' ? 'ok' : i.outcome === 'failed' ? 'bad' : 'neutral');

/** Every voice call, video call and meeting the person may see, with filters, and a way to start one. */
export default function CommunicationsPage() {
  const { can } = useAuth();
  const router = useRouter();
  const [type, setType] = useState('');
  const [kind, setKind] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [calling, setCalling] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const query = useMemo(() => ({ type: type || undefined, kind: kind || undefined, outcome: outcome || undefined, from: from || undefined, to: to || undefined, limit: 25 }), [type, kind, outcome, from, to]);
  const first = useApi<Page>('/communications', query);
  useRealtime(['call'], first.reload, 2_000);

  // "Show more" adds pages after the first; a change of filter starts again.
  const key = JSON.stringify(query);
  const [more, setMore] = useState<{ key: string; base: string | null; items: HistoryItem[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Pages added by "Show more" belong to one filter and to one first page; when either changes they are dropped.
  const base = first.data?.nextCursor ?? null;
  const extra = more?.key === key && more.base === base ? more : null;
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const cursor = extra ? extra.next : (first.data?.nextCursor ?? null);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api<Page>('/communications', { query: { ...query, cursor } });
      setMore({ key, base, items: [...(extra?.items ?? []), ...page.items], next: page.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  }

  if (!can('video.host')) return <Empty title="You do not have access to calls and meetings" />;
  return (
    <div className="space-y-4">
      <PageHeader title="Calls and meetings" subtitle="Voice calls, video calls and group meetings, with colleagues and with leads"
        actions={<>
          <Button variant="secondary" onClick={() => setCalling(true)}><Phone className="h-4 w-4" aria-hidden /> Call a colleague</Button>
          <Button onClick={() => setMeeting(true)}><Plus className="h-4 w-4" aria-hidden /> New meeting</Button>
        </>} />
      <Card className="p-3">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <Select aria-label="Calls or meetings" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Calls and meetings</option><option value="call">Calls</option><option value="meeting">Meetings</option>
          </Select>
          <Select aria-label="Voice or video" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Voice and video</option><option value="voice">Voice</option><option value="video">Video</option>
          </Select>
          <Select aria-label="What became of it" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">Any result</option><option value="open">Planned or running</option><option value="completed">Completed</option><option value="missed">Missed</option>
            <option value="declined">Declined</option><option value="busy">Busy</option><option value="cancelled">Cancelled</option><option value="failed">Failed</option>
          </Select>
          <Input aria-label="From date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input aria-label="To date" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </Card>

      {first.loading && !first.data ? <div className="grid place-items-center py-12"><Spinner /></div> : items.length === 0 ? (
        <Empty title="Nothing here yet">Start a call from a lead, call a colleague, or plan a meeting.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">When</th><th className="px-3 py-2.5 font-medium">What</th><th className="px-3 py-2.5 font-medium">People</th>
                <th className="px-3 py-2.5 font-medium">Duration</th><th className="px-3 py-2.5 font-medium">Result</th><th className="px-3 py-2.5 font-medium">Recording</th><th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((i) => (
                <tr key={i.id} className="hover:bg-head/60">
                  <td className="px-4 py-2.5 align-top tabular-nums">{fmtDateTime(i.scheduledFor ?? i.startedAt ?? i.createdAt)}</td>
                  <td className="px-3 py-2.5 align-top">
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink">{i.kind === 'voice' ? <Mic className="h-3.5 w-3.5 text-muted" aria-hidden /> : <Video className="h-3.5 w-3.5 text-muted" aria-hidden />}{i.title ?? (i.type === 'meeting' ? 'Meeting' : i.kind === 'voice' ? 'Voice call' : 'Video call')}</span>
                    <p className="text-xs text-muted">{i.type === 'meeting' ? 'Meeting' : 'Call'}{i.leadName ? ` · ${i.leadName}` : ''} · by {i.createdBy}</p>
                  </td>
                  <td className="px-3 py-2.5 align-top text-muted">{i.people}<span className="ml-1 text-xs">({i.peopleJoined}/{i.peopleInvited} joined)</span></td>
                  <td className="px-3 py-2.5 align-top tabular-nums">{fmtDuration(i.durationSec) || '—'}</td>
                  <td className="px-3 py-2.5 align-top"><Badge tone={tone(i)}>{i.phase === 'ended' && i.outcome ? OUTCOME_TEXT[i.outcome] : PHASE_TEXT[i.phase]}</Badge></td>
                  <td className="px-3 py-2.5 align-top text-xs text-muted">Off</td>
                  <td className="px-3 py-2.5 text-right align-top">
                    <span className="inline-flex gap-1.5">
                      {i.phase !== 'ended' && <Button size="sm" onClick={() => router.push(`/video/${i.id}`)}>Open</Button>}
                      <Button size="sm" variant="secondary" onClick={() => setOpen(i.id)}>Details</Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && <div className="border-t border-line p-3 text-center"><Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>Show more</Button></div>}
        </Card>
      )}
      {calling && <CallColleagueModal onClose={() => setCalling(false)} />}
      {meeting && <NewMeetingModal onClose={() => setMeeting(false)} onCreated={first.reload} />}
      {open && <SessionDetailModal id={open} onClose={() => setOpen(null)} onChanged={first.reload} />}
    </div>
  );
}
