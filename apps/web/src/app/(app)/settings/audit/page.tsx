'use client';

import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Input, Notice, Panel, Select, Spinner, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Entry {
  id: string;
  at: string;
  actor: { id: string; name: string } | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

/** The plain words for the kinds of action. Anything not listed is shown as it is stored. */
const GROUP: Record<string, string> = {
  auth: 'Sign-in and sessions', attendance: 'Attendance', salary: 'Salary', user: 'People', role: 'Roles', profile: 'Employee details', branch: 'Offices',
  company: 'Company profile', telephony: 'Telephony', api_key: 'API keys', lead: 'Leads', leave: 'Leave', device: 'Devices', holiday: 'Holidays',
};
const label = (action: string) => {
  const [group, ...rest] = action.split('.');
  return `${GROUP[group!] ?? group}: ${rest.join(' ').replace(/_/g, ' ') || 'change'}`;
};
const pretty = (v: unknown): string => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** What changed, as one line for each field that differs. */
function changes(before: unknown, after: unknown): { key: string; from: string; to: string }[] {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => ({ key: k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase(), from: pretty(b[k]), to: pretty(a[k]) }));
}

const today = () => new Date().toLocaleDateString('en-CA');
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');

export default function AuditPage() {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(today());
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = useApi<Page<{ id: string; name: string }>>('/users', useMemo(() => ({ limit: 100 }), []));
  const actions = useApi<string[]>('/audit-logs/actions');
  const query = useMemo(() => ({ limit: 50, from, to, actorId: actorId || undefined, action: action || undefined }), [from, to, actorId, action]);
  const list = useApi<Page<Entry>>('/audit-logs', query);

  // The groups of action present in the log, to fill the filter in plain words.
  const groups = useMemo(() => [...new Set((actions.data ?? []).map((a) => a.split('.')[0]!))].sort(), [actions.data]);

  const items = [...(list.data?.items ?? []), ...more];
  const cursor = next === undefined ? list.data?.nextCursor ?? null : next;

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api<Page<Entry>>('/audit-logs', { query: { ...query, cursor } });
      setMore((m) => [...m, ...page.items]);
      setNext(page.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }
  const reset = () => { setMore([]); setNext(undefined); setOpen(null); };

  return (
    <Panel title="Audit log" flush>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">A permanent record of sign-ins, role and user changes, attendance exceptions, salary edits and settings. Entries cannot be changed or deleted from the application.</p>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3">
        <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to} onChange={(e) => { if (e.target.value) { setFrom(e.target.value); reset(); } }} className="w-40" /></label>
        <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from} max={today()} onChange={(e) => { if (e.target.value) { setTo(e.target.value); reset(); } }} className="w-40" /></label>
        <Select aria-label="Person" value={actorId} onChange={(e) => { setActorId(e.target.value); reset(); }} className="w-52"><option value="">Everyone</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select aria-label="Kind of change" value={action} onChange={(e) => { setAction(e.target.value); reset(); }} className="w-60"><option value="">Every kind of change</option>{groups.map((g) => <option key={g} value={g}>{GROUP[g] ?? g}</option>)}</Select>
      </div>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : list.loading && !list.data ? <Spinner /> : items.length === 0 ? <Empty title="Nothing was recorded in this period" /> : (
        <>
          <ul className="divide-y divide-line">
            {items.map((e) => {
              const diff = changes(e.before, e.after);
              const isOpen = open === e.id;
              return (
                <li key={e.id}>
                  <button type="button" onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-mint-50">
                    <ChevronRight className={cx('h-4 w-4 shrink-0 text-subtle transition-transform', isOpen && 'rotate-90')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{label(e.action)}</span>
                      <span className="block text-xs text-muted">{e.actor ? e.actor.name : 'The system'}{e.ip ? ` · ${e.ip}` : ''}</span>
                    </span>
                    <Badge>{e.entity.replace(/_/g, ' ')}</Badge>
                    <span className="w-44 shrink-0 text-right text-xs text-muted">{fmtDateTime(e.at)}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-line bg-head px-12 py-3 text-sm">
                      {diff.length === 0 ? <p className="text-muted">No before and after values were kept for this entry.</p> : (
                        <dl className="space-y-1.5">
                          {diff.map((d) => <div key={d.key} className="grid gap-x-3 sm:grid-cols-[12rem_1fr]"><dt className="capitalize text-muted">{d.key}</dt><dd className="break-words"><span className="text-bad line-through decoration-bad/40">{d.from}</span><span className="mx-2 text-subtle">→</span><span className="font-medium text-ok">{d.to}</span></dd></div>)}
                        </dl>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {cursor && <div className="border-t border-line p-3 text-center"><Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>Show older entries</Button></div>}
        </>
      )}
    </Panel>
  );
}
