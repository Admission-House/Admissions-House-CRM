'use client';

import { Check, Copy, MessageCircle, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Input, Notice, Select } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { STATE_TEXT, type Participant, type SessionView } from '@/lib/communications';
import { useApi } from '@/lib/use-api';

const stateTone = (p: Participant) => (p.state === 'accepted' ? 'ok' : p.state === 'ringing' || p.state === 'invited' ? 'brand' : p.state === 'removed' ? 'neutral' : 'bad');

/**
 * Who is in a call or meeting, with what the host can do: take someone out, copy a guest's link, release a
 * link to a new device, add a colleague or a guest. The server decides who may; these buttons only show up
 * for people it would allow.
 */
export function PeoplePanel({ session, onChanged }: { session: SessionView; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [colleague, setColleague] = useState('');
  const [guest, setGuest] = useState('');
  const [busy, setBusy] = useState(false);
  const canAdd = session.canManage && session.type === 'meeting' && session.status === 'open';
  const colleagues = useApi<{ id: string; name: string; role: string }[]>(canAdd ? '/communications/colleagues' : null);

  async function run(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/communications/${session.id}/${path}`, { method: 'POST', body: body ?? {} });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(p: Participant) {
    if (!p.link) return;
    try {
      await navigator.clipboard.writeText(p.link);
      setCopied(p.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  }

  const invitedIds = new Set(session.participants.filter((p) => p.state !== 'removed').map((p) => p.userId));
  const people = session.participants;
  return (
    <section aria-label="People" className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">People ({people.filter((p) => p.state !== 'removed').length})</h2>
      {error && <Notice tone="bad">{error}</Notice>}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {people.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${p.connected ? 'bg-ok' : 'bg-line-strong'}`} aria-label={p.connected ? 'In the call' : 'Not in the call'} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-ink">{p.name}</span>
              <span className="ml-1.5 text-xs text-muted">{p.role === 'host' ? 'Host' : p.kind === 'guest' ? 'Guest' : 'Staff'}</span>
            </span>
            <Badge tone={stateTone(p)}>{STATE_TEXT[p.state]}</Badge>
            {session.canManage && p.state !== 'removed' && (
              <span className="flex items-center gap-1">
                {p.kind === 'guest' && p.link && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => void copy(p)} aria-label={`Copy the link for ${p.name}`}>{copied === p.id ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}</Button>
                    <a className="inline-flex h-7 items-center rounded-md border border-line-strong bg-surface px-2 text-xs hover:bg-head" target="_blank" rel="noopener noreferrer" aria-label={`Send the link to ${p.name} on WhatsApp`}
                      href={`https://wa.me/?text=${encodeURIComponent(`Hello ${p.name}, please join our ${session.kind === 'voice' ? 'voice' : 'video'} session using this link: ${p.link}`)}`}><MessageCircle className="h-3.5 w-3.5 text-ok" aria-hidden /></a>
                    {p.deviceBound && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(`invites/${p.id}/reset-device`)}>Release</Button>}
                  </>
                )}
                {p.role !== 'host' && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(`invites/${p.id}/remove`)} aria-label={`Take ${p.name} out`}><UserMinus className="h-3.5 w-3.5 text-bad" aria-hidden /></Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {canAdd && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Select aria-label="Add a colleague" value={colleague} onChange={(e) => setColleague(e.target.value)} className="flex-1">
              <option value="">Add a colleague…</option>
              {colleagues.data?.filter((c) => !invitedIds.has(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.role}</option>)}
            </Select>
            <Button size="sm" variant="secondary" disabled={!colleague || busy} onClick={() => { void run('invites', { userId: colleague }); setColleague(''); }}><UserPlus className="h-3.5 w-3.5" aria-hidden /> Add</Button>
          </div>
          <div className="flex gap-2">
            <Input aria-label="Guest name" placeholder="Guest name (gets a link)" value={guest} onChange={(e) => setGuest(e.target.value)} maxLength={80} />
            <Button size="sm" variant="secondary" disabled={!guest.trim() || busy} onClick={() => { void run('invites', { guestName: guest.trim() }); setGuest(''); }}><UserPlus className="h-3.5 w-3.5" aria-hidden /> Add</Button>
          </div>
        </div>
      )}
    </section>
  );
}
