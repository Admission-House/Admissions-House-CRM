'use client';

import { Mic, Phone, Plus, Video, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PeoplePanel } from '@/components/communications/people-panel';
import { Badge, Button, Field, Input, Notice, Select, Spinner, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { OUTCOME_TEXT, PHASE_TEXT, fmtDuration, type CallKind, type SessionDetail, type SessionView } from '@/lib/communications';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Colleague {
  id: string;
  name: string;
  role: string;
  busy: boolean;
}

function KindChoice({ kind, onChange }: { kind: CallKind; onChange: (k: CallKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Kind of call" className="grid grid-cols-2 gap-2">
      {([['video', 'Video', Video], ['voice', 'Voice', Mic]] as const).map(([key, text, Icon]) => (
        <button key={key} type="button" role="radio" aria-checked={kind === key} onClick={() => onChange(key)}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${kind === key ? 'border-brand bg-mint text-brand' : 'border-line-strong bg-surface text-ink hover:bg-head'}`}>
          <Icon className="h-4 w-4" aria-hidden /> {text}
        </button>
      ))}
    </div>
  );
}

/** Ring a colleague. The call opens at once; it rings on their screen until they answer, turn it down or miss it. */
export function CallColleagueModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const colleagues = useApi<Colleague[]>('/communications/colleagues');
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<CallKind>('voice');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ session: SessionView; busy: boolean }>('/communications/calls', { method: 'POST', body: { toUserId: who, kind } });
      if (r.busy) {
        setError('That person is already in a call. Try again in a moment.');
        colleagues.reload();
      } else {
        router.push(`/video/${r.session.id}`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Call a colleague" onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <KindChoice kind={kind} onChange={setKind} />
        <Field label="Who to call" htmlFor="cc">
          {colleagues.loading && !colleagues.data ? <Spinner /> : (
            <Select id="cc" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose a colleague…</option>
              {colleagues.data?.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.role}{c.busy ? ' (busy)' : ''}</option>)}
            </Select>
          )}
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button onClick={() => void start()} disabled={!who} loading={busy}><Phone className="h-4 w-4" aria-hidden /> Call</Button>
      </div>
    </Modal>
  );
}

/** Plan or start a group meeting with colleagues and outside guests. */
export function NewMeetingModal({ onClose, onCreated, lead }: { onClose: () => void; onCreated: () => void; lead?: { id: string; name: string } }) {
  const router = useRouter();
  const colleagues = useApi<Colleague[]>('/communications/colleagues');
  const [title, setTitle] = useState(lead ? `Meeting with ${lead.name}` : '');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<CallKind>('video');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [staff, setStaff] = useState<string[]>([]);
  // A meeting about a lead starts with the lead as a guest, who is sent a link of their own.
  const [guests, setGuests] = useState<string[]>(lead ? [lead.name.split(' ')[0] || 'Student'] : []);
  const [guest, setGuest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setStaff((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const addGuest = () => {
    const name = guest.trim();
    if (name) setGuests((g) => [...g, name]);
    setGuest('');
  };

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim(), kind, durationMinutes: Number(minutes), staffIds: staff, guests: guests.map((name) => ({ name })) };
      if (description.trim()) body.description = description.trim();
      if (lead) body.leadId = lead.id;
      if (when) body.scheduledFor = new Date(when).toISOString();
      const made = await api<SessionView>('/communications/meetings', { method: 'POST', body });
      onCreated();
      if (when) onClose();
      else router.push(`/video/${made.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New meeting" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <Field label="Title" htmlFor="mt" required><Input id="mt" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
        <Field label="What it is about (optional)" htmlFor="md"><Textarea id="md" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} /></Field>
        <KindChoice kind={kind} onChange={setKind} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Planned time (optional)" htmlFor="mw" hint="Leave empty to start now."><Input id="mw" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Field label="Length" htmlFor="ml">
            <Select id="ml" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              {[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Colleagues to invite</legend>
          {colleagues.loading && !colleagues.data && <Spinner />}
          <ul className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
            {colleagues.data?.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-head">
                  <input type="checkbox" checked={staff.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className="flex-1">{c.name} <span className="text-xs text-muted">{c.role}</span></span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink">Outside guests (each gets a link of their own)</p>
          <div className="flex gap-2">
            <Input aria-label="Guest name" value={guest} onChange={(e) => setGuest(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGuest(); } }} placeholder="Guest name" maxLength={80} />
            <Button variant="secondary" onClick={addGuest} disabled={!guest.trim()}><Plus className="h-4 w-4" aria-hidden /> Add</Button>
          </div>
          {guests.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {guests.map((g, i) => (
                <li key={`${g}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-mint px-2.5 py-1 text-xs text-brand">{g}
                  <button type="button" aria-label={`Remove ${g}`} onClick={() => setGuests((x) => x.filter((_, n) => n !== i))}><X className="h-3 w-3" aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button onClick={() => void create()} disabled={!title.trim()} loading={busy}>{when ? 'Plan the meeting' : 'Start the meeting'}</Button>
      </div>
    </Modal>
  );
}

const EVENT_TEXT: Record<string, string> = {
  created: 'Created', invited: 'Invited', ringing: 'Started ringing', accepted: 'Accepted', declined: 'Turned it down', missed: 'Did not answer', busy: 'Was busy',
  joined: 'Joined', left: 'Left', removed: 'Was taken out', reset: 'Link released', started: 'The session started', ended: 'The session ended', reminder: 'Reminder sent',
};

/** One session in full: who, when, how long, what happened, and the host's controls. */
export function SessionDetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useApi<SessionDetail>(`/communications/${id}`);
  const s = detail.data;
  return (
    <Modal title={s?.title ?? (s ? `${s.kind === 'voice' ? 'Voice' : 'Video'} call` : 'Session')} onClose={onClose} width="max-w-2xl">
      {!s ? <Spinner /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === 'open' ? 'brand' : s.outcome === 'completed' ? 'ok' : 'neutral'}>{s.status === 'ended' && s.outcome ? OUTCOME_TEXT[s.outcome] : PHASE_TEXT[s.phase]}</Badge>
            <Badge tone="info">{s.type === 'meeting' ? 'Meeting' : 'Call'} · {s.kind === 'voice' ? 'Voice' : 'Video'}</Badge>
            {s.durationSec !== null && <span className="text-sm text-muted">{fmtDuration(s.durationSec)}</span>}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="inline text-muted">Started by </dt><dd className="inline text-ink">{s.createdBy}</dd></div>
            {s.leadName && <div><dt className="inline text-muted">Lead </dt><dd className="inline text-ink">{s.leadName}{s.leadNo ? ` (#${s.leadNo})` : ''}</dd></div>}
            <div><dt className="inline text-muted">Made </dt><dd className="inline text-ink">{fmtDateTime(s.createdAt)}</dd></div>
            {s.scheduledFor && <div><dt className="inline text-muted">Planned for </dt><dd className="inline text-ink">{fmtDateTime(s.scheduledFor)}</dd></div>}
            {s.startedAt && <div><dt className="inline text-muted">Began </dt><dd className="inline text-ink">{fmtDateTime(s.startedAt)}</dd></div>}
            {s.endedAt && <div><dt className="inline text-muted">Ended </dt><dd className="inline text-ink">{fmtDateTime(s.endedAt)}</dd></div>}
            <div><dt className="inline text-muted">Recording </dt><dd className="inline text-ink">Not switched on</dd></div>
          </dl>
          {s.description && <p className="text-sm text-muted">{s.description}</p>}
          <PeoplePanel session={s} onChanged={() => { detail.reload(); onChanged(); }} />
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">What happened</h3>
            <ol className="space-y-1 text-sm">
              {s.events.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex gap-3">
                  <span className="w-36 shrink-0 text-xs tabular-nums text-muted">{fmtDateTime(e.at)}</span>
                  <span className="text-ink">{e.who ? `${e.who}: ` : ''}{EVENT_TEXT[e.event] ?? e.event}{e.detail ? <span className="text-muted"> ({e.detail})</span> : null}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}
