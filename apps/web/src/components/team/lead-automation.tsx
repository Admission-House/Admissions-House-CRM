'use client';

import { ArrowRightLeft, Power } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Notice, Panel, Spinner } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Person {
  id: string;
  name: string;
  status: string;
  role: { key: string | null; name: string };
  receivesAutoLeads: boolean;
}

interface TransferResult {
  moved: number;
  remaining: number;
  pausedAutomation: boolean;
  to: { id: string; name: string; leads: number }[];
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/**
 * For someone who hands out leads: stop new leads from going to a person automatically, and move the
 * leads they hold to other people (for example when their work is not good enough).
 */
export function LeadAutomation({ userId }: { userId: string }) {
  const { can } = useAuth();
  const person = useApi<Person>(can('lead.assign') ? `/users/${userId}` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [done, setDone] = useState<TransferResult | null>(null);

  if (!can('lead.assign')) return null;
  if (!person.data) return person.error ? <Notice tone="bad">{person.error.message}</Notice> : <Spinner />;
  const p = person.data;
  if (p.role.key !== 'counsellor') return null;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api(`/users/${userId}/lead-automation`, { method: 'PUT', body: { enabled: !p.receivesAutoLeads } });
      person.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Leads for this person"
      actions={<Badge tone={p.receivesAutoLeads ? 'ok' : 'warn'}>{p.receivesAutoLeads ? 'Gets new leads automatically' : 'New leads paused'}</Badge>}
    >
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted">
          Pausing stops new leads from being given to {p.name} automatically. Leads they already hold stay with them, and you can still give them a lead by hand.
          To take their work away, move their leads to other people.
        </p>
        {error && <Notice tone="bad">{error}</Notice>}
        {done && (
          <Notice tone="ok">
            Moved {done.moved} lead{done.moved === 1 ? '' : 's'}: {done.to.map((t) => `${t.leads} to ${t.name}`).join(', ')}.
            {done.remaining > 0 && ` ${done.remaining} more are still with ${p.name}; run it again to move them.`}
            {done.pausedAutomation && ' New leads are now paused for them.'}
          </Notice>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} onClick={() => void toggle()}>
            <Power className="h-4 w-4" aria-hidden /> {p.receivesAutoLeads ? 'Pause new leads' : 'Give new leads again'}
          </Button>
          <Button variant="secondary" onClick={() => { setDone(null); setMoving(true); }}>
            <ArrowRightLeft className="h-4 w-4" aria-hidden /> Move their leads to others
          </Button>
        </div>
      </div>
      {moving && (
        <MoveLeads
          from={p}
          onClose={() => setMoving(false)}
          onDone={(r) => { setMoving(false); setDone(r); person.reload(); }}
        />
      )}
    </Panel>
  );
}

function MoveLeads({ from, onClose, onDone }: { from: Person; onClose: () => void; onDone: (r: TransferResult) => void }) {
  const people = useApi<Page<Person>>('/users', { status: 'active', limit: 100 });
  const [chosen, setChosen] = useState<string[]>([]);
  const [which, setWhich] = useState<'open' | 'all'>('open');
  const [pause, setPause] = useState(true);
  const [anyone, setAnyone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = (people.data?.items ?? []).filter((x) => x.id !== from.id && x.role.key === 'counsellor');

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<TransferResult>('/leads/transfer', {
        method: 'POST',
        body: { fromUserId: from.id, toUserIds: chosen, which, pauseAutomation: pause, allowUnavailable: anyone },
      });
      onDone(result);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'ASSIGNEE_UNAVAILABLE') setAnyone(false);
    } finally {
      setBusy(false);
    }
  }

  const toggleChosen = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <Modal title={`Move ${from.name}'s leads`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-muted">Choose who should take the leads. With more than one person the leads are shared out evenly.</p>
        {people.loading && <Spinner />}
        {people.error && <Notice tone="bad">{people.error.message}</Notice>}
        <div className="max-h-56 space-y-1 overflow-auto rounded-md border border-line-strong p-2">
          {candidates.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-head">
              <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => toggleChosen(c.id)} />
              <span className="font-medium text-ink">{c.name}</span>
              {!c.receivesAutoLeads && <span className="text-xs text-muted">(new leads paused)</span>}
            </label>
          ))}
          {!people.loading && candidates.length === 0 && <p className="p-2 text-sm text-muted">There is nobody else you can give leads to.</p>}
        </div>

        <fieldset className="space-y-1.5 text-sm">
          <legend className="mb-1 font-medium text-ink">Which leads</legend>
          <label className="flex items-center gap-2"><input type="radio" name="which" checked={which === 'open'} onChange={() => setWhich('open')} /> Only leads still being worked (recommended)</label>
          <label className="flex items-center gap-2"><input type="radio" name="which" checked={which === 'all'} onChange={() => setWhich('all')} /> Every lead, including closed ones</label>
        </fieldset>

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} /> Also stop new leads from going to {from.name}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={anyone} onChange={(e) => setAnyone(e.target.checked)} /> Give even to people who are not at work right now</label>

        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={chosen.length === 0} onClick={() => void submit()}>Move leads</Button>
        </div>
      </div>
    </Modal>
  );
}
