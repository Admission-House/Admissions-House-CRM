'use client';

import { ArrowDownLeft, ArrowUpRight, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Spinner } from '@/components/ui';
import { MovableTh, useColumnOrder } from '@/components/ui/movable-columns';
import { OUTCOME, Recording, WrapUp, length, type Call } from '@/components/leads/calls-tab';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fmtPhone } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface CallRow extends Call {
  lead: { id: string; leadNo: string; name: string } | null;
}

type ColId = 'when' | 'lead' | 'call' | 'by' | 'outcome' | 'length' | 'remark';
const DEFAULT_COLUMNS: ColId[] = ['when', 'lead', 'call', 'by', 'outcome', 'length', 'remark'];

/** The columns of the table, each with its heading and what it shows for a call. The order is the person's own. */
const COLUMNS: Record<ColId, { label: string; td: string; title?: (c: CallRow) => string | undefined; cell: (c: CallRow) => ReactNode }> = {
  when: { label: 'When', td: 'whitespace-nowrap px-4 py-3 text-muted', cell: (c) => <>{fmtDateTime(c.startedAt)}</> },
  lead: { label: 'Lead', td: 'px-3 py-3', cell: (c) => <>{c.lead ? <Link href={`/leads/${c.lead.id}`} className="font-medium text-ink hover:text-brand-600">{c.lead.name}</Link> : <span className="text-subtle">Not a lead</span>}<p className="tabular text-xs text-muted">{fmtPhone(c.number)}</p></> },
  call: { label: 'Call', td: 'px-3 py-3', cell: (c) => <><span className="inline-flex items-center gap-1.5">{c.direction === 'incoming' ? <ArrowDownLeft className="h-4 w-4 text-info" aria-hidden /> : <ArrowUpRight className="h-4 w-4 text-ok" aria-hidden />}{c.direction === 'incoming' ? 'Incoming' : 'Outgoing'}</span></> },
  by: { label: 'By', td: 'px-3 py-3', cell: (c) => <>{c.user?.name ?? <span className="text-subtle">Unknown</span>}</> },
  outcome: { label: 'Outcome', td: 'px-3 py-3', cell: (c) => <><Badge tone={(OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const }).tone}>{(OUTCOME[c.outcome] ?? { label: c.outcome, tone: 'neutral' as const }).label}</Badge></> },
  length: { label: 'Length', td: 'tabular px-3 py-3', cell: (c) => <>{length(c.durationSec)}</> },
  remark: { label: 'Remark', td: 'max-w-56 truncate px-3 py-3 text-muted', title: (c) => c.remark ?? '', cell: (c) => <>{c.remark ?? ''}</> },
};

export default function CallsPage() {
  const { can, me } = useAuth();
  const columns = useColumnOrder(`calls:${me?.user.id ?? 'me'}`, DEFAULT_COLUMNS);
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
            {columns.changed && <div className="flex justify-end px-3 pt-2 text-xs"><button type="button" onClick={columns.reset} className="font-medium text-info hover:underline">Reset column order</button></div>}
            <table className="w-full text-left text-sm">
              <thead className="bg-head text-xs uppercase tracking-wide text-muted">
                <tr>{columns.order.map((id) => <MovableTh key={id} id={id} columns={columns} className="px-3 py-2.5 text-left font-semibold">{COLUMNS[id as ColId].label}</MovableTh>)}<th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((c) => {
                  return (
                    <tr key={c.id} className="hover:bg-mint-50">
                      {columns.order.map((id) => { const col = COLUMNS[id as ColId]; return <td key={id} className={col.td} title={col.title?.(c)}>{col.cell(c)}</td>; })}
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
