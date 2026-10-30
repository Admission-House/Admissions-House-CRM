'use client';

import { ArrowDownLeft, ArrowUpRight, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Spinner } from '@/components/ui';
import { OUTCOME, Recording, WrapUp, length, type Call } from '@/components/leads/calls-tab';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtPhone } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface CallRow extends Call {
  lead: { id: string; leadNo: string; name: string } | null;
}

export default function CallsPage() {
  const { can } = useAuth();
  const [userId, setUserId] = useState('');
  const [direction, setDirection] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [unwrapped, setUnwrapped] = useState(false);
  const [wrapping, setWrapping] = useState<CallRow | null>(null);

  const team = useApi<Page<{ id: string; name: string }>>(can('user.read') ? '/users' : null, { limit: 100, status: 'active' });
  const query = useMemo(
    () => ({ limit: 100, userId: userId || undefined, direction: direction || undefined, outcome: outcome || undefined, from: from || undefined, to: to || undefined, unwrapped: unwrapped ? 'true' : undefined }),
    [userId, direction, outcome, from, to, unwrapped],
  );
  const calls = useApi<Page<CallRow>>('/calls', query);
  const items = calls.data?.items ?? [];

  return (
    <>
      <PageHeader title="Call history" subtitle="Every incoming, outgoing and missed call, with the recording where there is one" />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
          {team.data && team.data.items.length > 1 && (
            <Select aria-label="Counsellor" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-48"><option value="">Every counsellor</option>{team.data.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          )}
          <Select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)} className="w-40"><option value="">All calls</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></Select>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-44"><option value="">Any outcome</option>{Object.entries(OUTCOME).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
          <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-40" /></label>
          <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-40" /></label>
          <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={unwrapped} onChange={(e) => setUnwrapped(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> After-call form pending</label>
        </div>

        {calls.error ? <div className="p-4"><Notice tone="bad">{calls.error.message}</Notice></div> : calls.loading && !calls.data ? <Spinner /> : items.length === 0 ? <Empty title="No calls match">Change the filters, or place a call from a lead.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr><th className="px-4 py-2.5 font-semibold">When</th><th className="px-3 py-2.5 font-semibold">Lead</th><th className="px-3 py-2.5 font-semibold">Call</th><th className="px-3 py-2.5 font-semibold">By</th><th className="px-3 py-2.5 font-semibold">Outcome</th><th className="px-3 py-2.5 font-semibold">Length</th><th className="px-3 py-2.5 font-semibold">Remark</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => {
                  const o = OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const };
                  return (
                    <tr key={c.id} className="hover:bg-mint-50">
                      <td className="whitespace-nowrap px-4 py-3 text-muted">{fmtDateTime(c.startedAt)}</td>
                      <td className="px-3 py-3">{c.lead ? <Link href={`/leads/${c.lead.id}`} className="font-medium text-ink hover:text-brand-600">{c.lead.name}</Link> : <span className="text-subtle">Not a lead</span>}<p className="tabular text-xs text-muted">{fmtPhone(c.number)}</p></td>
                      <td className="px-3 py-3"><span className="inline-flex items-center gap-1.5">{c.direction === 'incoming' ? <ArrowDownLeft className="h-4 w-4 text-info" aria-hidden /> : <ArrowUpRight className="h-4 w-4 text-ok" aria-hidden />}{c.direction === 'incoming' ? 'Incoming' : 'Outgoing'}</span></td>
                      <td className="px-3 py-3">{c.user?.name ?? <span className="text-subtle">Unknown</span>}</td>
                      <td className="px-3 py-3"><Badge tone={o.tone}>{o.label}</Badge></td>
                      <td className="tabular px-3 py-3">{length(c.durationSec)}</td>
                      <td className="max-w-56 truncate px-3 py-3 text-muted" title={c.remark ?? ''}>{c.remark ?? ''}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {c.recording === 'stored' && can('call.listen') && <Recording callId={c.id} />}
                          {c.recording === 'pending' && <span className="text-xs text-subtle">Recording on its way</span>}
                          {c.outcome === 'connected' && !c.wrappedUp && c.lead && can('lead.update') && <Button size="sm" onClick={() => setWrapping(c)}><ClipboardCheck className="h-3.5 w-3.5" aria-hidden /> After-call form</Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {wrapping && <WrapUp call={wrapping} onClose={() => setWrapping(null)} onDone={() => { setWrapping(null); calls.reload(); }} />}
    </>
  );
}
