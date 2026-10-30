'use client';

import { Download, FileUp } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Notice, PageHeader, Panel, Select, Spinner, Tabs } from '@/components/ui';
import { api, apiRaw, ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { SourceOption, StatusOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';

type Mapping = Record<string, string>;
interface Preview {
  fileName: string;
  columns: string[];
  mapping: Mapping;
  unmappedColumns: string[];
  missing: string[];
  totals: { rows: number; valid: number; invalid: number; repeatedInFile: number; alreadyInCrm: number };
  sample: { row: number; name: string; phone: string }[];
  problems: { row: number; name?: string; phone?: string; problem: string }[];
  problemsShown: number;
}
interface Batch {
  id: string;
  fileName: string;
  status: 'queued' | 'processing' | 'done' | 'cancelled';
  source: { id: string; name: string };
  assign: { mode: 'auto' | 'none' | 'user'; user: { id: string; name: string } | null };
  totals: { rows: number; invalid: number; toFile: number; processed: number; created: number; attached: number; rejected: number; failed: number };
  createdBy: { id: string; name: string };
  createdAt: string;
  finishedAt: string | null;
}

/** What each field of a lead is called, in the order the file is mapped. */
const FIELD_LABEL: Record<string, string> = {
  name: 'Name', phone: 'Phone', email: 'Email', level: 'Course level', mode: 'Study mode', stream: 'Stream', city: 'City', interest: 'Interest',
  utm_source: 'UTM source', utm_medium: 'UTM medium', utm_campaign: 'UTM campaign', utm_term: 'UTM term', utm_content: 'UTM content',
};
const STATUS_LABEL: Record<Batch['status'], { label: string; tone: 'warn' | 'info' | 'ok' | 'neutral' }> = { queued: { label: 'Waiting', tone: 'warn' }, processing: { label: 'Filing leads', tone: 'info' }, done: { label: 'Done', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'neutral' } };
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

function Totals({ items }: { items: { label: string; value: number; tone?: string }[] }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((i) => <li key={i.label} className="rounded-lg bg-head px-3 py-2.5"><p className={`tabular text-xl font-bold ${i.tone ?? 'text-ink'}`}>{i.value.toLocaleString('en-IN')}</p><p className="text-xs text-muted">{i.label}</p></li>)}
    </ul>
  );
}

// ------------------------------------------------------------------ progress

function BatchProgress({ id, onDone }: { id: string; onDone: () => void }) {
  const batch = useApi<Batch>(`/leads/import/${id}`);
  const running = batch.data?.status === 'queued' || batch.data?.status === 'processing';
  const reload = batch.reload;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [running, reload]);
  // Tell the page once when the import has finished, not on every render.
  const told = useRef(false);
  useEffect(() => {
    if (batch.data && !running && !told.current) {
      told.current = true;
      onDone();
    }
  }, [batch.data, running, onDone]);

  if (batch.error) return <Notice tone="bad">{batch.error.message}</Notice>;
  if (!batch.data) return <Spinner />;
  const b = batch.data;
  const pct = b.totals.toFile > 0 ? Math.min(100, Math.round((b.totals.processed / b.totals.toFile) * 100)) : 100;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm"><span className="font-medium">{b.fileName}</span><Badge tone={STATUS_LABEL[b.status].tone}>{STATUS_LABEL[b.status].label}</Badge></div>
      <div className="h-2.5 overflow-hidden rounded-full bg-head" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress"><div className="h-full rounded-full bg-teal-600 transition-all" style={{ width: `${pct}%` }} /></div>
      <Totals items={[{ label: 'New leads', value: b.totals.created, tone: 'text-ok' }, { label: 'Added to existing', value: b.totals.attached }, { label: 'Refused as repeats', value: b.totals.rejected }, { label: 'Failed', value: b.totals.failed, tone: b.totals.failed ? 'text-bad' : undefined }, { label: 'Skipped rows', value: b.totals.invalid, tone: b.totals.invalid ? 'text-warn' : undefined }]} />
      {b.totals.invalid > 0 && !running && <Button variant="secondary" size="sm" onClick={() => void download(`/leads/import/${b.id}/problems.csv`)}><Download className="h-3.5 w-3.5" aria-hidden /> Download the skipped rows</Button>}
    </div>
  );
}

// ------------------------------------------------------------------ import tab

function ImportLeads({ onImported }: { onImported: () => void }) {
  const sources = useApi<SourceOption[]>('/lead-sources');
  const people = useApi<{ items: { id: string; name: string; role: { name: string } }[] }>('/users', useMemo(() => ({ limit: 100, status: 'active' }), []));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [sourceId, setSourceId] = useState('');
  const [assign, setAssign] = useState<'auto' | 'none' | 'user'>('auto');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function read(f: File, m?: Mapping) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', f);
      if (m && Object.keys(m).length) form.set('mapping', JSON.stringify(m));
      const res = await apiRaw('/leads/import/preview', { method: 'POST', body: form });
      const p = (await res.json()) as Preview;
      setPreview(p);
      setMapping(p.mapping as Mapping);
    } catch (e) {
      setError(errorText(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('sourceId', sourceId);
      form.set('assign', assign);
      if (assign === 'user') form.set('userId', userId);
      form.set('mapping', JSON.stringify(mapping));
      const res = await apiRaw('/leads/import', { method: 'POST', body: form });
      setBatchId(((await res.json()) as Batch).id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null); setPreview(null); setMapping({}); setBatchId(null); setError(null);
    if (input.current) input.current.value = '';
  }

  if (batchId) {
    return (
      <Panel title="Importing">
        <BatchProgress id={batchId} onDone={onImported} />
        <div className="mt-4"><Button variant="secondary" onClick={reset}>Import another file</Button></div>
      </Panel>
    );
  }

  const canStart = !!preview && preview.missing.length === 0 && preview.totals.valid > 0 && !!sourceId && (assign !== 'user' || !!userId);
  return (
    <div className="space-y-4">
      <Panel title="1. Choose a file">
        <div className="space-y-3">
          <p className="text-sm text-muted">A CSV or Excel file with one lead on each row. You will see exactly what will happen before anything is saved.</p>
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" className="sr-only" aria-label="Leads file" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setPreview(null); if (f) void read(f); }} />
          <Button variant="secondary" onClick={() => input.current?.click()} loading={busy && !preview}><FileUp className="h-3.5 w-3.5" aria-hidden /> {file ? file.name : 'Choose a CSV or Excel file'}</Button>
          {error && <Notice tone="bad">{error}</Notice>}
        </div>
      </Panel>

      {preview && (
        <>
          <Panel title="2. Check the columns">
            <div className="space-y-4">
              <Totals items={[{ label: 'Rows in the file', value: preview.totals.rows }, { label: 'Ready to import', value: preview.totals.valid, tone: 'text-ok' }, { label: 'Have problems', value: preview.totals.invalid, tone: preview.totals.invalid ? 'text-bad' : undefined }, { label: 'Repeated in the file', value: preview.totals.repeatedInFile }, { label: 'Already in the CRM', value: preview.totals.alreadyInCrm }]} />
              {preview.missing.length > 0 && <Notice tone="bad">Match a column for {preview.missing.map((m) => FIELD_LABEL[m] ?? m).join(' and ')} to continue.</Notice>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Object.keys(FIELD_LABEL).map((f) => (
                  <Field key={f} label={`${FIELD_LABEL[f]}${f === 'name' || f === 'phone' ? ' *' : ''}`} htmlFor={`m-${f}`}>
                    <Select id={`m-${f}`} value={mapping[f] ?? ''} onChange={(e) => { const next = { ...mapping }; if (e.target.value) next[f] = e.target.value; else delete next[f]; setMapping(next); if (file) void read(file, next); }}>
                      <option value="">Not in this file</option>{preview.columns.map((c) => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
              {preview.sample.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-left text-sm"><thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="px-3 py-2 font-semibold">Row</th><th className="px-3 py-2 font-semibold">Name</th><th className="px-3 py-2 font-semibold">Phone</th></tr></thead>
                    <tbody className="divide-y divide-line">{preview.sample.map((s) => <tr key={s.row}><td className="tabular px-3 py-2 text-muted">{s.row}</td><td className="px-3 py-2">{s.name}</td><td className="tabular px-3 py-2">{s.phone}</td></tr>)}</tbody></table>
                </div>
              )}
              {preview.problems.length > 0 && (
                <details className="rounded-lg border border-line">
                  <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">{preview.totals.invalid} {preview.totals.invalid === 1 ? 'row has a problem' : 'rows have problems'} (showing {preview.problemsShown})</summary>
                  <ul className="divide-y divide-line border-t border-line text-sm">{preview.problems.map((p) => <li key={`${p.row}${p.problem}`} className="px-4 py-2"><Badge tone="bad">Row {p.row}</Badge> <span className="ml-1">{[p.name, p.phone].filter(Boolean).join(' · ')}{p.name || p.phone ? ': ' : ''}{p.problem}</span></li>)}</ul>
                </details>
              )}
            </div>
          </Panel>

          <Panel title="3. Source and owner">
            <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <Field label="Source of these leads" htmlFor="is" required><Select id="is" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">Choose a source</option>{sources.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Give them to" htmlFor="ia"><Select id="ia" value={assign} onChange={(e) => setAssign(e.target.value as typeof assign)}><option value="auto">Counsellors automatically</option><option value="user">One person</option><option value="none">Nobody for now</option></Select></Field>
              {assign === 'user' && <Field label="Person" htmlFor="iu" required><Select id="iu" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose a person</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role.name})</option>)}</Select></Field>}
            </div>
            <div className="mt-5 flex gap-2"><Button onClick={() => void start()} loading={busy} disabled={!canStart}>Import {preview.totals.valid.toLocaleString("en-IN")} {preview.totals.valid === 1 ? "lead" : "leads"}</Button><Button variant="secondary" onClick={reset}>Start over</Button></div>
          </Panel>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ past imports

function History({ refreshKey }: { refreshKey: number }) {
  const list = useApi<Batch[]>('/leads/import', useMemo(() => ({ k: refreshKey }), [refreshKey]));
  const [open, setOpen] = useState<string | null>(null);
  if (list.error) return <Notice tone="bad">{list.error.message}</Notice>;
  if (!list.data) return <Spinner />;
  return (
    <Panel title="Earlier imports" flush>
      {list.data.length === 0 ? <Empty title="No imports yet" /> : (
        <ul className="divide-y divide-line">
          {list.data.map((b) => (
            <li key={b.id} className="px-4 py-3.5">
              <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
                <span><span className="text-[15px] font-semibold">{b.fileName}</span><span className="ml-2 text-xs text-muted">{b.source.name} · {b.createdBy.name} · {fmtDateTime(b.createdAt)}</span></span>
                <span className="flex items-center gap-3 text-sm text-muted"><span>{b.totals.created} new</span><Badge tone={STATUS_LABEL[b.status].tone}>{STATUS_LABEL[b.status].label}</Badge></span>
              </button>
              {open === b.id && <div className="mt-3"><BatchProgress id={b.id} onDone={() => undefined} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------- export

function ExportLeads() {
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const sources = useApi<SourceOption[]>('/lead-sources');
  const [statusId, setStatusId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(format: 'csv' | 'xlsx') {
    setBusy(format);
    setError(null);
    try {
      await download('/leads/export', { statusId: statusId || undefined, sourceId: sourceId || undefined, createdFrom: from || undefined, createdTo: to || undefined, format });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Panel title="Export leads">
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-muted">Download the leads you are allowed to see. Leave everything empty to get all of them.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Status" htmlFor="es"><Select id="es" value={statusId} onChange={(e) => setStatusId(e.target.value)}><option value="">Every status</option>{statuses.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Source" htmlFor="eo"><Select id="eo" value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">Every source</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Created from" htmlFor="ef"><input id="ef" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm" /></Field>
          <Field label="Created to" htmlFor="et"><input id="et" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm" /></Field>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <div className="flex gap-2"><Button onClick={() => void go('xlsx')} loading={busy === 'xlsx'}><Download className="h-3.5 w-3.5" aria-hidden /> Excel</Button><Button variant="secondary" onClick={() => void go('csv')} loading={busy === 'csv'}><Download className="h-3.5 w-3.5" aria-hidden /> CSV</Button></div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------ colleges and fees

interface MasterResult {
  rows: number;
  colleges: { new: number; existing: number };
  courses: { new: number; existing: number };
  offers: { new: number; updated: number };
  problems: { row: number; college?: string; course?: string; problem: string }[];
  applied: boolean;
}

function MasterResultView({ result, onSave, busy }: { result: MasterResult; onSave: () => void; busy: boolean }) {
  const clean = result.problems.length === 0;
  return (
    <div className="space-y-3">
      <Notice tone={result.applied ? 'ok' : clean ? 'info' : 'warn'}>{result.applied ? 'Saved. ' : ''}{result.rows} rows read.</Notice>
      <Totals items={[{ label: 'New colleges', value: result.colleges.new, tone: 'text-ok' }, { label: 'Colleges already here', value: result.colleges.existing }, { label: 'New courses', value: result.courses.new, tone: 'text-ok' }, { label: 'New fee rows', value: result.offers.new, tone: 'text-ok' }, { label: 'Fee rows changed', value: result.offers.updated }]} />
      {result.problems.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">{result.problems.map((p) => <li key={`${p.row}${p.problem}`} className="px-4 py-2"><Badge tone="bad">Row {p.row}</Badge> <span className="ml-1">{[p.college, p.course].filter(Boolean).join(' · ')}{p.college || p.course ? ': ' : ''}{p.problem}</span></li>)}</ul>
      )}
      {!result.applied && clean && <Button onClick={onSave} loading={busy}>Save to the CRM</Button>}
      {!result.applied && !clean && <p className="text-sm text-muted">Fix these rows at the source and preview again. Nothing is saved while there are problems.</p>}
    </div>
  );
}

interface CollegeApiStatus { configured: boolean; host: string | null; itemsPath: string | null; fieldMap: Record<string, string> }

/** Loads colleges and fees from the college data provider's API, through the same preview-then-save path as a file. */
function CollegeApi() {
  const status = useApi<CollegeApiStatus>('/masters/college-api');
  const [result, setResult] = useState<MasterResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<MasterResult>(apply ? '/masters/college-api/sync' : '/masters/college-api/preview', { method: 'POST' }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="College data provider">
      {status.error ? <Notice tone="bad">{status.error.message}</Notice> : !status.data ? <Spinner /> : (
        <div className="max-w-3xl space-y-4">
          {status.data.configured ? (
            <p className="text-sm text-muted">Connected to <b className="text-ink">{status.data.host}</b>. Preview shows what loading would add or change; nothing is saved until you press Save.</p>
          ) : (
            <Notice tone="info">The college data connection is not set up yet. Once the provider is chosen, add COLLEGE_API_URL and COLLEGE_API_KEY to the server settings and this button starts working. Until then, use the file import below.</Notice>
          )}
          {status.data.configured && <Button onClick={() => void run(false)} loading={busy && !result}>Preview from the provider</Button>}
          {error && <Notice tone="bad">{error}</Notice>}
          {result && <MasterResultView result={result} onSave={() => void run(true)} busy={busy} />}
        </div>
      )}
    </Panel>
  );
}

function ImportMasters() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<MasterResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(apply: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      const res = await apiRaw(apply ? '/masters/import' : '/masters/import/preview', { method: 'POST', body: form });
      setResult((await res.json()) as MasterResult);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Import colleges, courses and fees from a file">
      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-muted">One row for each course a college offers. Columns the file can have: <b>College</b>, <b>City</b>, <b>State</b>, <b>Course</b>, <b>Level</b> (UG, PG, Diploma), <b>Stream</b>, <b>Mode</b> (online, regular, both), <b>CAF fee</b>, <b>Annual fee</b>, <b>Duration</b>. Everything is added together, or nothing is, so a mistake never leaves half a file behind.</p>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept=".csv,.xlsx,.xls" className="sr-only" aria-label="Colleges file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
          <Button variant="secondary" onClick={() => input.current?.click()}><FileUp className="h-3.5 w-3.5" aria-hidden /> {file ? file.name : 'Choose a CSV or Excel file'}</Button>
          <Button onClick={() => void run(false)} loading={busy && !result} disabled={!file}>Preview</Button>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        {result && <MasterResultView result={result} onSave={() => void run(true)} busy={busy} />}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------ page

export default function ImportsPage() {
  const { can } = useAuth();
  const tabs = [
    can('lead.import') && { key: 'import' as const, label: 'Import leads' },
    can('lead.import') && { key: 'history' as const, label: 'Earlier imports' },
    can('lead.export') && { key: 'export' as const, label: 'Export leads' },
    can('master.manage') && { key: 'masters' as const, label: 'Colleges and fees' },
  ].filter(Boolean) as { key: 'import' | 'history' | 'export' | 'masters'; label: string }[];
  const [tab, setTab] = useState<'import' | 'history' | 'export' | 'masters'>(tabs[0]?.key ?? 'import');
  const [refresh, setRefresh] = useState(0);
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;
  return (
    <>
      <PageHeader title="Import and export" subtitle="Bring leads in from a file, or take them out" />
      {tabs.length === 0 ? <Card><Empty title="Not available">Your role does not include import or export.</Empty></Card> : (
        <div className="space-y-4">
          {tabs.length > 1 && <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={tabs} value={active!} onChange={setTab} label="Import and export" /></div>}
          {active === 'import' && <ImportLeads onImported={() => setRefresh((n) => n + 1)} />}
          {active === 'history' && <History refreshKey={refresh} />}
          {active === 'export' && <ExportLeads />}
          {active === 'masters' && <div className="space-y-6"><CollegeApi /><ImportMasters /></div>}
        </div>
      )}
    </>
  );
}
