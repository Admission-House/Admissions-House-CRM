'use client';

import { ArrowDownLeft, ArrowUpRight, ClipboardCheck, Play } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Notice, Select, Spinner, Textarea } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { Page, StatusOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import type { LeadDetail } from './lead-panels';

export interface Call {
  id: string;
  direction: 'incoming' | 'outgoing';
  number: string;
  startedAt: string;
  durationSec: number | null;
  outcome: string;
  user: { id: string; name: string } | null;
  wrappedUp: boolean;
  remark: string | null;
  recording: 'none' | 'pending' | 'stored' | 'failed';
}

export const OUTCOME: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' | 'info' }> = {
  connected: { label: 'Connected', tone: 'ok' }, missed: { label: 'Missed', tone: 'bad' }, not_picked: { label: 'Not picked', tone: 'warn' },
  busy: { label: 'Busy', tone: 'warn' }, failed: { label: 'Failed', tone: 'bad' }, ringing: { label: 'Ringing', tone: 'info' }, requested: { label: 'Calling', tone: 'info' },
};
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
export const length = (s: number | null) => (s ? `${Math.floor(s / 60)}m ${s % 60}s` : '—');
const minLocal = () => {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** The after-call form: what the lead's status is now, a remark, and when to follow up. */
export function WrapUp({ call, onClose, onDone }: { call: Call; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [statusId, setStatusId] = useState('');
  const [remark, setRemark] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = statuses.data?.find((s) => s.id === statusId);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/calls/${call.id}/wrap-up`, { method: 'POST', body: { statusId, ...(remark.trim() && { remark: remark.trim() }), ...(due && { followUp: { dueAt: new Date(due).toISOString() } }) } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="After the call" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Status now" htmlFor="ws" required>
          <Select id="ws" value={statusId} onChange={(e) => setStatusId(e.target.value)} required>
            <option value="">Choose a status</option>
            {statuses.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {can('followup.manage') && chosen?.isOpen && (
          <Field label={chosen.requiresFollowup ? 'Next follow-up (required)' : 'Next follow-up'} htmlFor="wd">
            <Input id="wd" type="datetime-local" min={minLocal()} value={due} onChange={(e) => setDue(e.target.value)} required={!!chosen.requiresFollowup} />
          </Field>
        )}
        <Field label="Remark" htmlFor="wr"><Textarea id="wr" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={1000} placeholder="What was discussed?" /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Later</Button><Button type="submit" loading={busy} disabled={!statusId}>Save</Button></div>
      </form>
    </Modal>
  );
}

export function Recording({ callId }: { callId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      setUrl((await api<{ url: string }>(`/calls/${callId}/recording/link`, { method: 'POST', body: {} })).url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (url) return <audio controls autoPlay src={url} className="h-8 w-56 max-w-full" />;
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" loading={busy} onClick={() => void load()}><Play className="h-3 w-3" aria-hidden /> Listen</Button>
      {error && <span role="alert" className="text-xs text-bad">{error}</span>}
    </span>
  );
}

export function CallsTab({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const { can } = useAuth();
  const calls = useApi<Page<Call>>(`/leads/${lead.id}/calls`, { limit: 50 });
  const [wrapping, setWrapping] = useState<Call | null>(null);

  if (calls.loading && !calls.data) return <Spinner />;
  if (calls.error) return <Notice tone="bad">{calls.error.message}</Notice>;
  const items = calls.data?.items ?? [];
  if (items.length === 0) return <Card><Empty title="No calls yet">Calls to and from this student will be listed here.</Empty></Card>;

  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-head text-xs uppercase tracking-wide text-muted">
          <tr><th className="px-4 py-2.5">When</th><th className="px-3 py-2.5">Call</th><th className="px-3 py-2.5">By</th><th className="px-3 py-2.5">Outcome</th><th className="px-3 py-2.5">Length</th><th className="px-3 py-2.5">Remark</th><th className="px-4 py-2.5 text-right" /></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((c) => {
            const o = OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const };
            return (
              <tr key={c.id}>
                <td className="px-4 py-2.5 text-muted">{fmtDateTime(c.startedAt)}</td>
                <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5">{c.direction === 'incoming' ? <ArrowDownLeft className="h-3.5 w-3.5 text-info" aria-hidden /> : <ArrowUpRight className="h-3.5 w-3.5 text-ok" aria-hidden />}{c.direction === 'incoming' ? 'Incoming' : 'Outgoing'}</span></td>
                <td className="px-3 py-2.5">{c.user?.name ?? <span className="text-subtle">Unknown</span>}</td>
                <td className="px-3 py-2.5"><Badge tone={o.tone}>{o.label}</Badge></td>
                <td className="tabular px-3 py-2.5">{length(c.durationSec)}</td>
                <td className="max-w-64 truncate px-3 py-2.5 text-muted" title={c.remark ?? ''}>{c.remark ?? ''}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    {c.recording === 'stored' && can('call.listen') && <Recording callId={c.id} />}
                    {c.recording === 'pending' && <span className="text-xs text-subtle">Recording on its way</span>}
                    {c.outcome === 'connected' && !c.wrappedUp && can('lead.update') && <Button size="sm" onClick={() => setWrapping(c)}><ClipboardCheck className="h-3.5 w-3.5" aria-hidden /> After-call form</Button>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {wrapping && <WrapUp call={wrapping} onClose={() => setWrapping(null)} onDone={() => { setWrapping(null); calls.reload(); onChanged(); }} />}
    </Card>
  );
}
