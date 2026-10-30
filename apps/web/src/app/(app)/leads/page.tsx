'use client';

import { Download, ExternalLink, PhoneCall, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { AddLeadModal } from '@/components/leads/add-lead-modal';
import { Avatar, Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Spinner, cx } from '@/components/ui';
import { api, ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtPhone, fromNow } from '@/lib/format';
import type { LeadListItem, Page, Queues, SourceOption, StatusOption, UserOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const QUEUE_CHIPS = [
  { key: '', label: 'All', dot: undefined },
  { key: 'fresh', label: 'Fresh', dot: 'bg-teal-600' },
  { key: 'missed', label: 'Missed', dot: 'bg-bad' },
  { key: 'followup', label: 'Follow-up', dot: 'bg-info' },
  { key: 'counselled', label: 'Counselled', dot: 'bg-[#6b5bd2]' },
  { key: 'fee_paid', label: 'Application fee paid', dot: 'bg-ok' },
  { key: 'closed', label: 'Closed', dot: 'bg-subtle' },
] as const;

const FILTER_KEYS = ['q', 'queue', 'statusId', 'sourceId', 'assignedTo', 'intent', 'studyMode', 'followup', 'createdFrom', 'createdTo', 'sort'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const PAGE_SIZE = 25;

const INTENT_TONE = { hot: 'bad', warm: 'warn', cold: 'info' } as const;
const queueTone = (q: string) => (q === 'missed' ? 'bad' : q === 'fee_paid' ? 'ok' : q === 'closed' ? 'neutral' : q === 'fresh' ? 'brand' : 'info');

function BulkBar({ ids, statuses, people, onDone, onClear }: { ids: string[]; statuses: StatusOption[]; people: UserOption[]; onDone: (message: string) => void; onClear: () => void }) {
  const { can } = useAuth();
  const [assignTo, setAssignTo] = useState('');
  const [statusId, setStatusId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the chosen person is absent, on leave or on a break: the Admin may still hand the leads over.
  const [unavailable, setUnavailable] = useState(false);

  async function run(label: string, path: string, body: object) {
    setBusy(true);
    setError(null);
    setUnavailable(false);
    try {
      const r = await api<{ requested: number; changed: number }>(path, { method: 'POST', body: { leadIds: ids, ...body } });
      onDone(`${label}: ${r.changed} of ${r.requested} updated.`);
    } catch (e) {
      setUnavailable(e instanceof ApiError && e.code === 'ASSIGNEE_UNAVAILABLE');
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticky top-14 z-10 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-brand/20 bg-mint-soft px-4 py-2.5 shadow-card">
      <span className="text-sm font-semibold text-brand">{ids.length} selected</span>
      {can('lead.assign') && (
        <div className="flex gap-2">
          <Select aria-label="Assign selected leads to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="w-44">
            <option value="">Assign to…</option>
            <option value="none">Unassigned pool</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!assignTo} loading={busy} onClick={() => void run('Assigned', '/leads/bulk/assign', { userId: assignTo === 'none' ? null : assignTo })}>Assign</Button>
        </div>
      )}
      {can('lead.assign') && (
        <div className="flex gap-2">
          <Select aria-label="Change status of selected leads" value={statusId} onChange={(e) => setStatusId(e.target.value)} className="w-44">
            <option value="">Change status to…</option>
            {statuses.filter((s) => s.isActive !== false && !(s.isOpen && s.requiresFollowup)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!statusId} loading={busy} onClick={() => void run('Status changed', '/leads/bulk/status', { statusId })}>Apply</Button>
        </div>
      )}
      <button onClick={onClear} className="ml-auto text-xs font-medium text-muted hover:text-ink">Clear selection</button>
      {error && (
        <div className="w-full">
          <Notice tone="bad">
            {error}
            {unavailable && <> <button type="button" className="font-semibold underline" onClick={() => void run('Assigned', '/leads/bulk/assign', { userId: assignTo, allowUnavailable: true })}>Assign anyway</button></>}
          </Notice>
        </div>
      )}
    </div>
  );
}

function Leads() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useAuth();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>, [params]);

  const [typed, setTyped] = useState<string | null>(null);
  const search = typed ?? filters.q;
  const [extra, setExtra] = useState<{ key: string; items: LeadListItem[]; next: string | null } | null>(null);
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  const queues = useApi<Queues>('/leads/queues');
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const sources = useApi<SourceOption[]>('/lead-sources');
  const people = useApi<Page<UserOption>>(can('user.read') ? '/users' : null, { limit: 100, status: 'active' });

  const set = useCallback(
    (patch: Partial<Record<FilterKey, string>>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) q.set(k, v);
        else q.delete(k);
      }
      setSelected(new Set());
      router.replace(`/leads${q.size ? `?${q}` : ''}`, { scroll: false });
    },
    [params, router],
  );

  // Typing in the search box waits a moment before it asks the server.
  useEffect(() => {
    if (typed === null) return;
    const t = setTimeout(() => {
      set({ q: typed.trim() });
      setTyped(null);
    }, 350);
    return () => clearTimeout(t);
  }, [typed, set]);

  const query = useMemo(() => ({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), limit: PAGE_SIZE }), [filters]);
  const queryKey = JSON.stringify(query);
  const first = useApi<Page<LeadListItem>>('/leads', query);
  const loading = first.loading && !first.data;
  const extraNow = extra?.key === queryKey ? extra : null;
  const items = [...(first.data?.items ?? []), ...(extraNow?.items ?? [])];
  const next = extraNow ? extraNow.next : (first.data?.nextCursor ?? null);

  async function showMore() {
    if (!next) return;
    setMore(true);
    try {
      const page = await api<Page<LeadListItem>>('/leads', { query: { ...query, cursor: next } });
      setExtra({ key: queryKey, items: [...(extraNow?.items ?? []), ...page.items], next: page.nextCursor });
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Cannot reach the server.' });
    } finally {
      setMore(false);
    }
  }

  const advanced = ['statusId', 'sourceId', 'assignedTo', 'intent', 'studyMode', 'followup', 'createdFrom', 'createdTo'] as const;
  const activeFilters = advanced.filter((k) => filters[k]).length;
  const count = (key: string) => (key === '' ? queues.data?.total : queues.data?.queues[key]);
  const allSelected = items.length > 0 && items.every((l) => selected.has(l.id));

  async function exportFile(format: 'csv' | 'xlsx') {
    setExporting(true);
    setNotice(null);
    try {
      const { q, queue, statusId, sourceId, assignedTo, intent, studyMode, followup, createdFrom, createdTo } = filters;
      await download('/leads/export', { q, queue, statusId, sourceId, assignedTo, intent, studyMode, followup, createdFrom, createdTo, format });
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof ApiError ? e.message : 'The export failed. Try again.' });
    } finally {
      setExporting(false);
    }
  }

  async function callLead(id: string) {
    setNotice(null);
    try {
      await api(`/leads/${id}/call`, { method: 'POST', body: {} });
      setNotice({ tone: 'ok', text: 'Calling your phone now. Pick it up and the student will be connected.' });
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Cannot reach the server.' });
    }
  }

  return (
    <>
      <PageHeader
        title="Leads"
        subtitle={queues.data ? `${queues.data.total} in total${queues.data.unassigned > 0 && can('lead.assign') ? ` · ${queues.data.unassigned} not assigned yet` : ''}` : undefined}
        actions={
          <>
            {can('lead.export') && <Button variant="secondary" onClick={() => void exportFile('xlsx')} loading={exporting}><Download className="h-3.5 w-3.5" aria-hidden /> Export</Button>}
            {can('lead.create') && <Button onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden /> New lead</Button>}
          </>
        }
      />

      {notice && <div className="mb-3"><Notice tone={notice.tone}>{notice.text}</Notice></div>}

      <div className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Queues">
        {QUEUE_CHIPS.map((c) => {
          const on = filters.queue === c.key;
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => set({ queue: c.key })}
              className={cx('-mb-px flex shrink-0 items-baseline gap-2 border-b-2 px-3.5 pb-2.5 pt-1 text-[15px] transition-colors', on ? 'border-brand font-semibold text-brand' : 'border-transparent font-medium text-muted hover:text-ink')}
            >
              {c.label}
              <span className={cx('tabular text-xs', on ? 'text-brand-600' : 'text-subtle')}>{count(c.key) ?? ''}</span>
            </button>
          );
        })}
      </div>

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label="Search leads" placeholder="Search name, phone, email or lead no." value={search} onChange={(e) => setTyped(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Sort" value={filters.sort} onChange={(e) => set({ sort: e.target.value })} className="w-44">
            <option value="">Newest first</option>
            <option value="updated">Recently updated</option>
            <option value="followup">Next follow-up</option>
          </Select>
          <Button variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> Filters{activeFilters > 0 && <span className="tabular rounded-full bg-brand px-1.5 text-xs text-white">{activeFilters}</span>}
          </Button>
          {(activeFilters > 0 || filters.q || filters.queue) && <Button variant="ghost" onClick={() => router.replace('/leads')}><X className="h-3.5 w-3.5" aria-hidden /> Reset</Button>}
        </div>
        {showFilters && (
          <div className="grid gap-3 border-t border-line p-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <Select aria-label="Status" value={filters.statusId} onChange={(e) => set({ statusId: e.target.value })}>
              <option value="">Any status</option>
              {statuses.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select aria-label="Source" value={filters.sourceId} onChange={(e) => set({ sourceId: e.target.value })}>
              <option value="">Any source</option>
              {sources.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select aria-label="Assigned to" value={filters.assignedTo} onChange={(e) => set({ assignedTo: e.target.value })}>
              <option value="">Anyone</option>
              <option value="me">Me</option>
              {can('lead.assign') && <option value="unassigned">Not assigned</option>}
              {people.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Select aria-label="Follow-up" value={filters.followup} onChange={(e) => set({ followup: e.target.value })}>
              <option value="">Any follow-up</option>
              <option value="today">Due today</option>
              <option value="overdue">Overdue</option>
              <option value="upcoming">Upcoming</option>
            </Select>
            <Select aria-label="Intent" value={filters.intent} onChange={(e) => set({ intent: e.target.value })}>
              <option value="">Any intent</option>
              <option value="hot">Hot</option>
              <option value="warm">Warm</option>
              <option value="cold">Cold</option>
            </Select>
            <Select aria-label="Study mode" value={filters.studyMode} onChange={(e) => set({ studyMode: e.target.value })}>
              <option value="">Online or regular</option>
              <option value="online">Online</option>
              <option value="regular">Regular</option>
            </Select>
            <label className="relative block"><span className="pointer-events-none absolute -top-2 left-2 bg-surface px-1 text-xs font-medium text-muted">Added from</span><Input type="date" value={filters.createdFrom} onChange={(e) => set({ createdFrom: e.target.value })} /></label>
            <label className="relative block"><span className="pointer-events-none absolute -top-2 left-2 bg-surface px-1 text-xs font-medium text-muted">Added to</span><Input type="date" value={filters.createdTo} onChange={(e) => set({ createdTo: e.target.value })} /></label>
          </div>
        )}
      </Card>

      {selected.size > 0 && (
        <BulkBar
          ids={[...selected]}
          statuses={statuses.data ?? []}
          people={people.data?.items ?? []}
          onClear={() => setSelected(new Set())}
          onDone={(text) => {
            setNotice({ tone: 'ok', text });
            setSelected(new Set());
            setExtra(null);
            first.reload();
            queues.reload();
          }}
        />
      )}

      {first.error ? (
        <Notice tone="bad">{first.error.message}</Notice>
      ) : loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Card><Empty title="No leads match">Try removing a filter, or add a lead by hand.</Empty></Card>
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-head text-[13px] text-muted">
                <tr>
                  <th className="w-10 px-4 py-2.5">
                    <input type="checkbox" aria-label="Select all leads on this page" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((l) => l.id)) : new Set())} className="h-3.5 w-3.5 accent-[#0f625e]" />
                  </th>
                  <th className="px-3 py-3 font-medium">Lead</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Source</th>
                  <th className="px-3 py-3 font-medium">Assigned to</th>
                  <th className="px-3 py-3 font-medium">Next follow-up</th>
                  <th className="px-3 py-3 font-medium">Updated</th>
                  <th className="px-4 py-2.5 text-right font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((l) => {
                  const late = !!l.nextFollowupAt && new Date(l.nextFollowupAt) < new Date() && l.status.isOpen;
                  return (
                    <tr key={l.id} className={cx('transition-colors hover:bg-mint-50', selected.has(l.id) && 'bg-mint-soft')}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })} className="h-3.5 w-3.5 accent-[#0f625e]" />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={l.name} size={30} tone="soft" />
                          <div className="min-w-0">
                            <Link href={`/leads/${l.id}`} className="block truncate font-medium text-ink hover:text-brand-600 hover:underline">{l.name}</Link>
                            <p className="flex items-center gap-1.5 text-xs text-muted"><span className="tabular">{fmtPhone(l.phone)}</span><span aria-hidden>·</span><span>#{l.leadNo}</span>{l.intent && <Badge tone={INTENT_TONE[l.intent]}>{l.intent}</Badge>}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5"><Badge tone={queueTone(l.queue)}>{l.status.name}</Badge></td>
                      <td className="px-3 py-2.5 text-muted">{l.source.name}</td>
                      <td className="px-3 py-2.5">{l.assignedTo?.name ?? <span className="text-subtle">Unassigned</span>}</td>
                      <td className="px-3 py-2.5">
                        {l.nextFollowupAt ? <span className={cx('tabular', late ? 'font-medium text-bad' : 'text-ink')} title={fmtDate(l.nextFollowupAt)}>{fromNow(l.nextFollowupAt)}</span> : <span className="text-subtle">&mdash;</span>}
                      </td>
                      <td className="px-3 py-2.5 text-muted"><span className="tabular">{fromNow(l.updatedAt)}</span></td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          {can('call.place') && l.status.isOpen && <button onClick={() => void callLead(l.id)} aria-label={`Call ${l.name}`} title="Call" className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-info-50 hover:text-info"><PhoneCall className="h-[17px] w-[17px]" /></button>}
                          <Link href={`/leads/${l.id}`} aria-label={`Open ${l.name}`} title="Open" className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-head hover:text-ink"><ExternalLink className="h-[17px] w-[17px]" /></Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <ul className="space-y-2 md:hidden">
            {items.map((l) => (
              <li key={l.id}>
                <Link href={`/leads/${l.id}`} className="block rounded-lg border border-line bg-surface p-3.5 shadow-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={l.name} size={32} tone="soft" />
                      <div className="min-w-0"><p className="truncate text-sm font-medium">{l.name}</p><p className="text-xs text-muted">{fmtPhone(l.phone)} · #{l.leadNo}</p></div>
                    </div>
                    <Badge tone={queueTone(l.queue)}>{l.status.name}</Badge>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span>{l.source.name}</span>
                    <span>{l.assignedTo?.name ?? 'Not assigned'}</span>
                    {l.nextFollowupAt && <span className={cx(new Date(l.nextFollowupAt) < new Date() && l.status.isOpen && 'font-medium text-bad')}>Follow-up {fromNow(l.nextFollowupAt)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center justify-between text-xs text-muted">
            <span className="tabular">Showing {items.length} lead{items.length === 1 ? '' : 's'}</span>
            {next && <Button variant="secondary" loading={more} onClick={() => void showMore()}>Show more</Button>}
          </div>
        </>
      )}

      {adding && (
        <AddLeadModal
          sources={sources.data?.filter((s) => s.isActive !== false) ?? []}
          people={people.data?.items ?? []}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            router.push(`/leads/${id}`);
          }}
        />
      )}
    </>
  );
}

export default function LeadsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Leads />
    </Suspense>
  );
}
