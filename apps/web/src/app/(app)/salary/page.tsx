'use client';

import { Download, FileUp } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ChartCard } from '@/components/charts';
import { Badge, Button, Card, Empty, Input, Notice, PageHeader, Panel, Select, Spinner, Tabs } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, apiRaw, ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Salary {
  id: string;
  user: { id: string; name: string; email: string; role: string };
  month: string;
  basePay: number;
  allowances: number;
  deductions: number;
  netPay: number;
  notes: string | null;
  enteredBy: string;
}
interface Detail extends Salary { attendance: { workingDays: number; present: number; late: number; leaveDays: number; absent: number } | null }
interface ImportResult { month: string; rows: number; toAdd: number; toChange: number; problems: { row: number; email?: string; problem: string }[]; applied: boolean }

const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const monthName = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7);

function MonthInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <label className="flex items-center gap-2 text-sm text-muted">Month<Input type="month" value={value} max={thisMonth()} onChange={(e) => e.target.value && onChange(e.target.value)} className="w-44" /></label>;
}

function SalaryTable({ rows, showPerson, onOpen }: { rows: Salary[]; showPerson?: boolean; onOpen?: (s: Salary) => void }) {
  if (rows.length === 0) return <Empty title="No salary records" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-head text-xs uppercase tracking-wide text-muted">
          <tr><th className="px-4 py-2.5 font-semibold">{showPerson ? 'Person' : 'Month'}</th>{showPerson && <th className="px-3 py-2.5 font-semibold">Month</th>}<th className="px-3 py-2.5 text-right font-semibold">Base pay</th><th className="px-3 py-2.5 text-right font-semibold">Allowances</th><th className="px-3 py-2.5 text-right font-semibold">Deductions</th><th className="px-3 py-2.5 text-right font-semibold">Net pay</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((s) => (
            <tr key={s.id} className="hover:bg-mint-50">
              <td className="px-4 py-3 font-medium">{showPerson ? <>{s.user.name}<span className="block text-xs font-normal text-muted">{s.user.role}</span></> : monthName(s.month)}</td>
              {showPerson && <td className="px-3 py-3">{monthName(s.month)}</td>}
              <td className="tabular px-3 py-3 text-right">{rupees(s.basePay)}</td>
              <td className="tabular px-3 py-3 text-right">{rupees(s.allowances)}</td>
              <td className="tabular px-3 py-3 text-right">{rupees(s.deductions)}</td>
              <td className="tabular px-3 py-3 text-right font-semibold text-brand">{rupees(s.netPay)}</td>
              <td className="px-4 py-3"><div className="flex justify-end gap-2">{onOpen && <Button size="sm" variant="secondary" onClick={() => onOpen(s)}>Open</Button>}<Button size="sm" variant="secondary" onClick={() => void download(`/salaries/${s.id}/payslip.pdf`)}><Download className="h-3.5 w-3.5" aria-hidden /> Payslip</Button></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ my salary

function MySalary() {
  const mine = useApi<Salary[]>('/salaries/mine');
  const chart = useMemo(() => (mine.data ?? []).slice(0, 12).reverse().map((s) => ({ month: s.month.slice(0, 7), net: s.netPay })), [mine.data]);
  if (mine.error) return <Notice tone="bad">{mine.error.message}</Notice>;
  if (!mine.data) return <Spinner />;
  return (
    <div className="space-y-4">
      {chart.length > 1 && <ChartCard title="Net pay by month" rows={chart} xKey="month" series={[{ key: 'net', label: 'Net pay' }]} kinds={['bar', 'area']} height={220} />}
      <Panel title="My salary" flush><SalaryTable rows={mine.data} /></Panel>
    </div>
  );
}

// ------------------------------------------------------------- monthly report

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<Detail>(`/salaries/${id}`);
  const a = d.data?.attendance;
  return (
    <Modal title={d.data ? `${d.data.user.name}, ${monthName(d.data.month)}` : 'Salary'} onClose={onClose}>
      {d.error ? <Notice tone="bad">{d.error.message}</Notice> : !d.data ? <Spinner /> : (
        <div className="space-y-4">
          <dl className="divide-y divide-line rounded-lg border border-line text-sm">
            {[['Base pay', d.data.basePay], ['Allowances', d.data.allowances], ['Deductions', d.data.deductions]].map(([k, v]) => <div key={k as string} className="flex justify-between px-4 py-2.5"><dt className="text-muted">{k}</dt><dd className="tabular font-medium">{rupees(v as number)}</dd></div>)}
            <div className="flex justify-between bg-head px-4 py-2.5"><dt className="font-semibold">Net pay</dt><dd className="tabular font-bold text-brand">{rupees(d.data.netPay)}</dd></div>
          </dl>
          {d.data.notes && <p className="text-sm text-muted">{d.data.notes}</p>}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Attendance that month (for reference only)</p>
            {a ? (
              <ul className="grid grid-cols-5 gap-2 text-center">
                {[['Working days', a.workingDays], ['Present', a.present], ['Late', a.late], ['Leave', a.leaveDays], ['Absent', a.absent]].map(([k, v]) => <li key={k as string} className="rounded-lg bg-head px-2 py-2"><p className="tabular text-lg font-bold text-ink">{v}</p><p className="text-xs text-muted">{k}</p></li>)}
              </ul>
            ) : <p className="text-sm text-muted">Attendance is not tracked for this person.</p>}
          </div>
          <p className="text-xs text-subtle">Entered by {d.data.enteredBy}. The amount does not change with attendance.</p>
          <div className="flex justify-end"><Button variant="secondary" onClick={() => void download(`/salaries/${id}/payslip.pdf`)}><Download className="h-3.5 w-3.5" aria-hidden /> Payslip PDF</Button></div>
        </div>
      )}
    </Modal>
  );
}

function MonthlyReport() {
  const { can } = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [userId, setUserId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const people = useApi<Page<{ id: string; name: string }>>('/users', { limit: 100, status: 'active' });
  const query = useMemo(() => ({ month, userId: userId || undefined, limit: 100 }), [month, userId]);
  const list = useApi<Page<Salary>>('/salaries', query);
  const [error, setError] = useState<string | null>(null);
  const total = (list.data?.items ?? []).reduce((n, s) => n + s.netPay, 0);
  const chart = useMemo(() => (list.data?.items ?? []).map((s) => ({ name: s.user.name, net: s.netPay })).sort((a, b) => b.net - a.net).slice(0, 25), [list.data]);

  async function save(format: 'csv' | 'xlsx') {
    setError(null);
    try { await download('/salaries/report', { month, userId: userId || undefined, format }); } catch (e) { setError(errorText(e)); }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <MonthInput value={month} onChange={setMonth} />
        <Select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-52"><option value="">Everyone</option>{people.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <div className="ml-auto flex gap-2">{can('report.export') || can('salary.read') ? <><Button variant="secondary" size="sm" onClick={() => void save('csv')}><Download className="h-3.5 w-3.5" aria-hidden /> CSV</Button><Button variant="secondary" size="sm" onClick={() => void save('xlsx')}><Download className="h-3.5 w-3.5" aria-hidden /> Excel</Button></> : null}</div>
      </div>
      {error && <Notice tone="bad">{error}</Notice>}
      {list.error ? <Notice tone="bad">{list.error.message}</Notice> : !list.data ? <Spinner /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4"><p className="text-xs font-semibold uppercase tracking-wide text-muted">People paid</p><p className="tabular mt-1 text-2xl font-bold text-brand">{list.data.items.length}</p></Card>
            <Card className="p-4 sm:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Total net pay, {monthName(month)}</p><p className="tabular mt-1 text-2xl font-bold text-brand">{rupees(total)}</p></Card>
          </div>
          {chart.length > 0 && <ChartCard title="Net pay by person" rows={chart} xKey="name" series={[{ key: 'net', label: 'Net pay' }]} kinds={['bar', 'list']} horizontal={chart.length > 6} height={220} />}
          <Panel title="Salary records" flush><SalaryTable rows={list.data.items} showPerson onOpen={(s) => setOpen(s.id)} /></Panel>
        </>
      )}
      {open && <DetailModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ----------------------------------------------------------------- bulk entry

type Draft = { base: string; allow: string; ded: string };

function BulkEntry() {
  const [month, setMonth] = useState(thisMonth());
  const people = useApi<Page<{ id: string; name: string; role: { name: string } }>>('/users', { limit: 100, status: 'active' });
  const existing = useApi<Page<Salary>>('/salaries', useMemo(() => ({ month, limit: 100 }), [month]));
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const saved = useMemo(() => new Map((existing.data?.items ?? []).map((s) => [s.user.id, s])), [existing.data]);
  const valueOf = (id: string): Draft => edits[id] ?? (saved.get(id) ? { base: String(saved.get(id)!.basePay), allow: String(saved.get(id)!.allowances), ded: String(saved.get(id)!.deductions) } : { base: '', allow: '', ded: '' });
  const set = (id: string, k: keyof Draft, v: string) => setEdits((e) => ({ ...e, [id]: { ...valueOf(id), [k]: v } }));
  const net = (d: Draft) => (Number(d.base) || 0) + (Number(d.allow) || 0) - (Number(d.ded) || 0);

  async function saveAll() {
    const rows = Object.entries(edits).filter(([, d]) => d.base !== '').map(([userId, d]) => ({ userId, basePay: Number(d.base), allowances: Number(d.allow) || 0, deductions: Number(d.ded) || 0 }));
    if (rows.length === 0) return setMsg({ tone: 'bad', text: 'Enter at least one base pay.' });
    setBusy(true);
    setMsg(null);
    try {
      await api('/salaries/bulk', { method: 'POST', body: { month, rows } });
      setEdits({});
      existing.reload();
      setMsg({ tone: 'ok', text: `${rows.length} salary ${rows.length === 1 ? 'record was' : 'records were'} saved for ${monthName(month)}.` });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Enter salaries for a month" flush actions={<Button onClick={() => void saveAll()} loading={busy} disabled={Object.keys(edits).length === 0}>Save {Object.keys(edits).length || ''} changes</Button>}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3"><MonthInput value={month} onChange={(m) => { setMonth(m); setEdits({}); }} /><p className="text-xs text-muted">Net pay is base pay plus allowances minus deductions. Leave base pay empty to skip a person.</p></div>
      {msg && <div className="p-3 pb-0"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {people.error ? <div className="p-4"><Notice tone="bad">{people.error.message}</Notice></div> : !people.data || !existing.data ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 font-semibold">Base pay</th><th className="px-3 py-2.5 font-semibold">Allowances</th><th className="px-3 py-2.5 font-semibold">Deductions</th><th className="px-3 py-2.5 text-right font-semibold">Net pay</th></tr></thead>
            <tbody className="divide-y divide-line">
              {people.data.items.map((p) => {
                const d = valueOf(p.id);
                return (
                  <tr key={p.id} className={edits[p.id] ? 'bg-mint-50' : ''}>
                    <td className="px-4 py-2"><span className="font-medium">{p.name}</span><span className="block text-xs text-muted">{p.role.name}{saved.has(p.id) ? ' · saved' : ''}</span></td>
                    {(['base', 'allow', 'ded'] as const).map((k) => <td key={k} className="px-3 py-2"><Input aria-label={`${k === 'base' ? 'Base pay' : k === 'allow' ? 'Allowances' : 'Deductions'} of ${p.name}`} inputMode="decimal" value={d[k]} onChange={(e) => set(p.id, k, e.target.value)} className="w-32" /></td>)}
                    <td className="tabular px-3 py-2 text-right font-semibold">{d.base !== '' ? rupees(net(d)) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- sheet import

function SheetImport() {
  const [month, setMonth] = useState(thisMonth());
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(apply: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('month', month);
      form.set('file', file);
      const res = await apiRaw(apply ? '/salaries/import' : '/salaries/import/preview', { method: 'POST', body: form });
      setResult((await res.json()) as ImportResult);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Upload a salary sheet">
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-muted">One row per person. Columns: <b>Email</b>, <b>Base pay</b>, <b>Allowances</b>, <b>Deductions</b>, <b>Notes</b>. You see what will change before anything is saved.</p>
        <MonthInput value={month} onChange={(m) => { setMonth(m); setResult(null); }} />
        <div className="flex flex-wrap items-center gap-3">
          <input ref={input} type="file" accept=".csv,.xlsx" className="sr-only" aria-label="Salary sheet" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
          <Button variant="secondary" onClick={() => input.current?.click()}><FileUp className="h-3.5 w-3.5" aria-hidden /> {file ? file.name : 'Choose a CSV or Excel file'}</Button>
          <Button onClick={() => void run(false)} loading={busy && !result} disabled={!file}>Preview</Button>
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        {result && (
          <div className="space-y-3">
            <Notice tone={result.applied ? 'ok' : 'info'}>{result.applied ? 'Saved. ' : ''}{result.rows} rows read for {monthName(result.month)}: {result.toAdd} new, {result.toChange} changed, {result.problems.length} with problems.</Notice>
            {result.problems.length > 0 && (
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">{result.problems.map((p) => <li key={`${p.row}${p.problem}`} className="px-4 py-2"><Badge tone="bad">Row {p.row}</Badge> <span className="ml-1">{p.email ? `${p.email}: ` : ''}{p.problem}</span></li>)}</ul>
            )}
            {!result.applied && result.rows - result.problems.length > 0 && <Button onClick={() => void run(true)} loading={busy}>Save {result.toAdd + result.toChange} records</Button>}
          </div>
        )}
      </div>
    </Panel>
  );
}

// --------------------------------------------------------------------- page

export default function SalaryPage() {
  const { can } = useAuth();
  const tabs = [
    can('salary.read_own') && { key: 'mine' as const, label: 'My salary' },
    can('salary.read') && { key: 'report' as const, label: 'Monthly report' },
    can('salary.write') && { key: 'bulk' as const, label: 'Bulk entry' },
    can('salary.import') && { key: 'import' as const, label: 'Upload sheet' },
  ].filter(Boolean) as { key: 'mine' | 'report' | 'bulk' | 'import'; label: string }[];
  const [tab, setTab] = useState<'mine' | 'report' | 'bulk' | 'import'>(tabs[0]?.key ?? 'mine');
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]?.key;
  return (
    <>
      <PageHeader title="Salary" subtitle="Entered by people, not calculated. Attendance is shown beside it for reference." />
      {tabs.length === 0 ? <Notice tone="warn">Your role does not include salary.</Notice> : (
        <div className="space-y-4">
          {tabs.length > 1 && <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={tabs} value={active!} onChange={setTab} label="Salary" /></div>}
          {active === 'mine' && <MySalary />}
          {active === 'report' && <MonthlyReport />}
          {active === 'bulk' && <BulkEntry />}
          {active === 'import' && <SheetImport />}
        </div>
      )}
    </>
  );
}
