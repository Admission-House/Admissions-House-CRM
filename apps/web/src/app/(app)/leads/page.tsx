'use client';

import { LeadCallMenu, type CallMenuLead } from '@/components/communications/lead-call-menu';
import { NewMeetingModal } from '@/components/communications/session-modals';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, ExternalLink, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AddLeadModal } from '@/components/leads/add-lead-modal';
import { Avatar, Badge, Button, Card, Empty, Input, Notice, PageHeader, Select, Spinner, cx } from '@/components/ui';
import { MovableTh, useColumnOrder } from '@/components/ui/movable-columns';
import { api, ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePhoneReady } from '@/lib/use-phone';
import { fmtDateTime, fmtPhone, fromNow } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
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

const FILTER_KEYS = ['q', 'queue', 'statusId', 'sourceId', 'assignedTo', 'intent', 'studyMode', 'followup', 'createdFrom', 'createdTo', 'since', 'junk', 'sort', 'orderBy', 'dir'] as const;

/** What the server sorts by for each column heading (the arrows in it). */
const ORDER_BY: Record<string, string> = { lead: 'name', email: 'email', course: 'course', region: 'region', status: 'status', source: 'source', assigned: 'assigned', received: 'received', followup: 'followup', updated: 'updated' };

/** "Received in the last ...", for when a lead came in a few hours or days ago rather than on a calendar date. */
const SINCE = [
  { key: '', label: 'Any time', ms: 0 },
  { key: '3h', label: 'Last 3 hours', ms: 3 * 3_600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { key: '3d', label: 'Last 3 days', ms: 3 * 86_400_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
] as const;

/** The moment "the last 3 hours" (and so on) began, as a timestamp the server understands. */
const sinceIso = (key: string): string => new Date(Date.now() - (SINCE.find((x) => x.key === key)?.ms ?? 0)).toISOString();
type FilterKey = (typeof FILTER_KEYS)[number];
/** Leads on one page of the list: 1-100, then 101-200 and so on. */
const PAGE_SIZE = 100;
/** The most leads one bulk action takes (the server's limit too): ten full pages. */
const MAX_BULK = 1000;

const INTENT_TONE = { hot: 'bad', warm: 'warn', cold: 'info' } as const;
const queueTone = (q: string) => (q === 'missed' ? 'bad' : q === 'fee_paid' ? 'ok' : q === 'closed' ? 'neutral' : q === 'fresh' ? 'brand' : 'info');

type ColId = 'lead' | 'email' | 'course' | 'region' | 'status' | 'source' | 'assigned' | 'received' | 'followup' | 'updated';

const dash = <span className="text-subtle">&mdash;</span>;

/** The columns of the table, each with its heading and what it shows for a lead. The order is the person's own (see useColumnOrder). */
const COLUMNS: Record<ColId, { label: string; td: string; title?: (l: LeadListItem) => string | undefined; cell: (l: LeadListItem) => ReactNode }> = {
  lead: {
    label: 'Lead',
    td: 'px-3 py-2.5',
    cell: (l) => (
      <div className="flex items-center gap-2.5">
        <Avatar name={l.name} size={30} tone="soft" />
        <div className="min-w-0">
          <Link href={`/leads/${l.id}`} className="block truncate font-medium text-ink hover:text-brand-600 hover:underline">{l.name}</Link>
          <p className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted"><span className="tabular">{fmtPhone(l.phone)}</span><span aria-hidden>·</span><span>#{l.leadNo}</span>{l.intent && <Badge tone={INTENT_TONE[l.intent]}>{l.intent}</Badge>}</p>
        </div>
      </div>
    ),
  },
  email: { label: 'Email', td: 'max-w-[14rem] truncate px-3 py-2.5 text-muted', title: (l) => l.email ?? undefined, cell: (l) => l.email ?? dash },
  course: { label: 'Course', td: 'max-w-[12rem] truncate px-3 py-2.5', title: (l) => l.course ?? undefined, cell: (l) => l.course ?? dash },
  region: { label: 'Region', td: 'max-w-[10rem] truncate px-3 py-2.5', title: (l) => l.region ?? undefined, cell: (l) => l.region ?? dash },
  status: { label: 'Status', td: 'whitespace-nowrap px-3 py-2.5', cell: (l) => <Badge tone={queueTone(l.queue)}>{l.status.name}</Badge> },
  source: { label: 'Source', td: 'px-3 py-2.5 text-muted', cell: (l) => l.source?.name },
  assigned: { label: 'Assigned to', td: 'whitespace-nowrap px-3 py-2.5', cell: (l) => l.assignedTo?.name ?? <span className="text-subtle">Unassigned</span> },
  received: {
    label: 'Received',
    td: 'whitespace-nowrap px-3 py-2.5',
    cell: (l) => <div className="tabular leading-tight"><p className="font-medium text-ink">{fmtDateTime(l.createdAt)}</p><p className="text-xs text-muted">{fromNow(l.createdAt)}</p></div>,
  },
  followup: {
    label: 'Next follow-up',
    td: 'whitespace-nowrap px-3 py-2.5',
    cell: (l) => {
      if (!l.nextFollowupAt) return dash;
      const late = new Date(l.nextFollowupAt) < new Date() && l.status.isOpen;
      return (
        <div className={cx('tabular leading-tight', late ? 'text-bad' : 'text-ink')}>
          <p className="font-medium">{fmtDateTime(l.nextFollowupAt)}</p>
          <p className={cx('text-xs', late ? 'text-bad' : 'text-muted')}>{fromNow(l.nextFollowupAt)}</p>
        </div>
      );
    },
  },
  updated: {
    label: 'Updated',
    td: 'whitespace-nowrap px-3 py-2.5 text-muted',
    cell: (l) => <div className="tabular leading-tight"><p>{fmtDateTime(l.updatedAt)}</p><p className="text-xs text-subtle">{fromNow(l.updatedAt)}</p></div>,
  },
};

function BulkBar({ ids, statuses, people, onDone, onClear }: { ids: string[]; statuses: StatusOption[]; people: UserOption[]; onDone: (message: string) => void; onClear: () => void }) {
  const { can } = useAuth();
  const [assignTo, setAssignTo] = useState('');
  const [statusId, setStatusId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the chosen person is absent, on leave or on a break: the Admin may still hand the leads over.
  const [unavailable, setUnavailable] = useState(false);
  const tooMany = ids.length > MAX_BULK;

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
      {tooMany && <span className="text-sm font-medium text-bad">At most {MAX_BULK} at a time. Untick {ids.length - MAX_BULK}.</span>}
      {can('lead.assign') && (
        <div className="flex gap-2">
          <Select aria-label="Assign selected leads to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="w-44">
            <option value="">Assign to…</option>
            <option value="none">Unassigned pool</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!assignTo || tooMany} loading={busy} onClick={() => void run('Assigned', '/leads/bulk/assign', { userId: assignTo === 'none' ? null : assignTo })}>Assign</Button>
        </div>
      )}
      {can('lead.assign') && (
        <div className="flex gap-2">
          <Select aria-label="Change status of selected leads" value={statusId} onChange={(e) => setStatusId(e.target.value)} className="w-44">
            <option value="">Change status to…</option>
            {statuses.filter((s) => s.isActive !== false && s.selectable !== false && !(s.isOpen && s.requiresFollowup)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!statusId || tooMany} loading={busy} onClick={() => void run('Status changed', '/leads/bulk/status', { statusId })}>Apply</Button>
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
  const showSource = can('lead.source');
  const { me } = useAuth();
  const columns = useColumnOrder(`leads:${me?.user.id ?? 'me'}`, useMemo<ColId[]>(() => ['lead', 'email', 'course', 'region', 'status', ...(showSource ? (['source'] as const) : []), 'assigned', 'received', 'followup', 'updated'], [showSource]));
  const phoneReady = usePhoneReady();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>, [params]);

  const [typed, setTyped] = useState<string | null>(null);
  const search = typed ?? filters.q;
  // The pages already passed, as the cursor each one starts from (null = the first page). Kept per filter set.
  const [trail, setTrail] = useState<{ key: string; cursors: (string | null)[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  const queues = useApi<Queues>('/leads/queues');
  useRealtime(['lead'], queues.reload, 5_000);
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
      // One or two letters are too short for the server to search; wait for a third (numbers are lead IDs).
      const word = typed.trim();
      if (word === '' || word.length >= 3 || /^\d+$/.test(word)) {
        set({ q: word });
        setTyped(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [typed, set]);

  // The Follow-up queue is a list of calls to make: the one due soonest comes first, unless the person chose another order.
  const query = useMemo(() => {
    const { since, ...rest } = filters;
    return { ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v)), ...(since && { createdAfter: sinceIso(since) }), ...(filters.queue === 'followup' && !filters.sort && { sort: 'followup' }), limit: PAGE_SIZE };
  }, [filters]);
  const queryKey = JSON.stringify(query);
  const cursors = trail?.key === queryKey ? trail.cursors : [null];
  const pageNo = cursors.length - 1;
  const cursor = cursors[pageNo];
  const first = useApi<Page<LeadListItem>>('/leads', cursor ? { ...query, cursor } : query);
  const loading = first.loading && !first.data;
  const items = first.data?.items ?? [];
  const next = first.data?.nextCursor ?? null;
  const from = pageNo * PAGE_SIZE + 1;

  function goTo(list: (string | null)[]) {
    setTrail({ key: queryKey, cursors: list });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const pager = (
    <>
      <span className="tabular" aria-live="polite">Showing {from}&ndash;{from + items.length - 1}</span>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" size="sm" disabled={pageNo === 0 || first.loading} onClick={() => goTo(cursors.slice(0, -1))}><ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Previous</Button>
        <Button variant="secondary" size="sm" disabled={!next || first.loading} onClick={() => next && goTo([...cursors, next])}>Next <ChevronRight className="h-3.5 w-3.5" aria-hidden /></Button>
      </div>
    </>
  );

  const advanced = ['statusId', 'sourceId', 'assignedTo', 'intent', 'studyMode', 'followup', 'createdFrom', 'createdTo', 'since', 'junk'] as const;
  const activeFilters = advanced.filter((k) => filters[k]).length;
  const count = (key: string) => (key === '' ? queues.data?.total : queues.data?.queues[key]);
  const allSelected = items.length > 0 && items.every((l) => selected.has(l.id));
  // The box in the heading ticks or unticks this page only; leads ticked on other pages stay ticked.
  const selectPage = (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const l of items) if (on) n.add(l.id); else n.delete(l.id);
      return n;
    });

  async function exportFile(format: 'csv' | 'xlsx') {
    setExporting(true);
    setNotice(null);
    try {
      const { q, queue, statusId, sourceId, assignedTo, intent, studyMode, followup, createdFrom, createdTo, since, junk } = filters;
      await download('/leads/export', { q, queue, statusId, sourceId, assignedTo, intent, studyMode, followup, createdFrom, createdTo, junk, ...(since && { createdAfter: sinceIso(since) }), format });
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof ApiError ? e.message : 'The export failed. Try again.' });
    } finally {
      setExporting(false);
    }
  }

  // Voice and video calls and meetings need the calling service to be set up; ask once, not for every row.
  const comm = useApi<{ enabled: boolean }>(can('video.host') ? '/communications/status' : null);
  const [meetingFor, setMeetingFor] = useState<CallMenuLead | null>(null);

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

      {filters.queue === 'followup' && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="When the call is due">
          {([['', 'All'], ['today', 'Due today'], ['upcoming', 'Later']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filters.followup === key}
              onClick={() => set({ followup: key })}
              className={cx('rounded-full border px-3 py-1 text-xs font-medium', filters.followup === key ? 'border-brand bg-brand text-white' : 'border-line bg-surface text-muted hover:text-ink')}
            >
              {label}
            </button>
          ))}
          <span className="text-xs text-subtle">A call whose time has passed moves to Missed leads.</span>
        </div>
      )}

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-60 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <Input aria-label="Search leads" placeholder="Search name, phone, email or lead no." value={search} onChange={(e) => setTyped(e.target.value)} className="pl-8" />
          </div>
          <Select aria-label="Sort" value={filters.orderBy ? 'column' : filters.sort} onChange={(e) => set({ sort: e.target.value === 'column' ? filters.sort : e.target.value, orderBy: '', dir: '' })} className="w-44">
            {filters.orderBy && <option value="column">Sorted by a column</option>}
            <option value="">Newest first</option>
            <option value="oldest">Oldest first</option>
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
            {showSource && (
              <Select aria-label="Source" value={filters.sourceId} onChange={(e) => set({ sourceId: e.target.value })}>
                <option value="">Any source</option>
                {sources.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
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
            <Select aria-label="Received" value={filters.since} onChange={(e) => set({ since: e.target.value })}>
              {SINCE.map((x) => <option key={x.key} value={x.key}>{x.key ? `Received: ${x.label.toLowerCase()}` : 'Received: any time'}</option>)}
            </Select>
            <Select aria-label="Junk leads" value={filters.junk} onChange={(e) => set({ junk: e.target.value })}>
              <option value="">Junk: show all</option>
              <option value="hide">Hide junk leads</option>
              <option value="only">Only junk leads</option>
            </Select>
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
            first.reload();
            queues.reload();
          }}
        />
      )}

      {items.length > 0 && !first.error && <div className="mb-2 flex items-center text-xs text-muted">{pager}</div>}

      {first.error ? (
        <Notice tone="bad">{first.error.message}</Notice>
      ) : loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Card><Empty title="No leads match">Try removing a filter, or add a lead by hand.</Empty></Card>
      ) : (
        <>
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-head text-[13px] text-muted">
                <tr>
                  <th className="w-10 px-4 py-2.5">
                    <input type="checkbox" aria-label="Select all leads on this page" title="Select the leads on this page" checked={allSelected} onChange={(e) => selectPage(e.target.checked)} className="h-3.5 w-3.5 accent-[#0f625e]" />
                  </th>
                  {columns.order.map((id) => {
                    const by = ORDER_BY[id];
                    const on = !!by && filters.orderBy === by;
                    const down = on && filters.dir === 'desc';
                    const label = COLUMNS[id as ColId].label;
                    return (
                      <MovableTh key={id} id={id} columns={columns} label={label} ariaSort={on ? (down ? 'descending' : 'ascending') : 'none'} className="px-3 py-3 text-left font-medium">
                        {by ? (
                          <button
                            type="button"
                            onClick={() => set({ orderBy: by, dir: on && !down ? 'desc' : 'asc' })}
                            title={on ? (down ? 'Sorted Z to A, newest or latest first. Click for A to Z.' : 'Sorted A to Z, oldest or earliest first. Click for Z to A.') : `Sort by ${label}`}
                            className={`group inline-flex items-center gap-1 rounded hover:text-ink ${on ? 'text-ink' : ''}`}
                          >
                            {label}
                            {on ? (down ? <ArrowDown className="h-3.5 w-3.5 text-brand-600" aria-hidden /> : <ArrowUp className="h-3.5 w-3.5 text-brand-600" aria-hidden />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-40 group-hover:opacity-100" aria-hidden />}
                          </button>
                        ) : label}
                      </MovableTh>
                    );
                  })}
                  <th className="sticky right-0 z-10 bg-head px-3 py-2.5 text-right font-semibold shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.12)]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((l) => {
                  return (
                    <tr key={l.id} className={cx('transition-colors hover:bg-mint-50', selected.has(l.id) && 'bg-mint-soft')}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" aria-label={`Select ${l.name}`} checked={selected.has(l.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(l.id); else n.delete(l.id); return n; })} className="h-3.5 w-3.5 accent-[#0f625e]" />
                      </td>
                      {columns.order.map((id) => { const c = COLUMNS[id as ColId]; return <td key={id} className={c.td} title={c.title?.(l)}>{c.cell(l)}</td>; })}
                      <td className={cx('sticky right-0 z-10 px-3 py-2.5 shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.12)]', selected.has(l.id) ? 'bg-mint-soft' : 'bg-surface')}>
                        <div className="flex justify-end gap-1">
                          {(can('call.place') || can('video.host')) && l.status.isOpen && (
                            <LeadCallMenu lead={{ id: l.id, name: l.name }} phone={can('call.place') && phoneReady ? { enabled: true, onCall: () => void callLead(l.id) } : undefined}
                              internet={can('video.host') && comm.data?.enabled === true} onMeeting={setMeetingFor} onError={(text) => setNotice({ tone: 'bad', text })} />
                          )}
                          <Link href={`/leads/${l.id}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.name} in a new tab`} title="Open in a new tab" className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-head hover:text-ink"><ExternalLink className="h-[17px] w-[17px]" /></Link>
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
                <Link href={`/leads/${l.id}`} className="block glass rounded-xl p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={l.name} size={32} tone="soft" />
                      <div className="min-w-0"><p className="truncate text-sm font-medium">{l.name}</p><p className="text-xs text-muted">{fmtPhone(l.phone)} · #{l.leadNo}</p></div>
                    </div>
                    <Badge tone={queueTone(l.queue)}>{l.status.name}</Badge>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    {showSource && <span>{l.source?.name}</span>}
                    {l.course && <span>{l.course}</span>}
                    {l.region && <span>{l.region}</span>}
                    {l.email && <span className="max-w-full truncate">{l.email}</span>}
                    <span>{l.assignedTo?.name ?? 'Not assigned'}</span>
                    <span>Received {fmtDateTime(l.createdAt)}</span>
                    {l.nextFollowupAt && <span className={cx(new Date(l.nextFollowupAt) < new Date() && l.status.isOpen && 'font-medium text-bad')}>Follow-up {fmtDateTime(l.nextFollowupAt)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-3 text-xs text-muted">
            {columns.changed && <button type="button" onClick={columns.reset} className="font-medium text-info hover:underline">Reset column order</button>}
            {pager}
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
      {meetingFor && <NewMeetingModal lead={meetingFor} onClose={() => setMeetingFor(null)} onCreated={() => undefined} />}
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
