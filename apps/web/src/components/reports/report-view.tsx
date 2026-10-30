'use client';

import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ChartCard, type Row } from '@/components/charts';
import { Button, Card, Empty, Notice, Select, Spinner } from '@/components/ui';
import { ApiError, download } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

export interface Report {
  title: string;
  from?: string;
  to?: string;
  columns: { key: string; label: string }[];
  rows: Row[];
}

const isNumber = (v: unknown) => typeof v === 'number';
const fmt = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('en-IN') : v);

/**
 * Shows one report from the API as it is meant to be read: a chart of the figure you pick, a trend
 * over the days when the report has them, and the full table underneath. Every report has the same
 * shape, so this one view serves all of them, and the same data downloads as CSV or Excel.
 */
export function ReportView({ path, query, chartFirst }: { path: string; query?: Record<string, string | number | undefined>; chartFirst?: string }) {
  const { can } = useAuth();
  const report = useApi<Report>(path, query);
  const [pick, setPick] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = report.data;
  const numeric = useMemo(
    () => (data ? data.columns.filter((c) => data.rows.length > 0 && data.rows.every((r) => r[c.key] === null || isNumber(r[c.key])) && c.key !== 'day') : []),
    [data],
  );
  const metric = numeric.find((c) => c.key === pick) ?? numeric.find((c) => c.key === chartFirst) ?? numeric[0];
  const byDay = !!data && data.columns.some((c) => c.key === 'day') && data.columns.some((c) => c.key === 'name');
  const labelKey = data?.columns.find((c) => !numeric.includes(c) && c.key !== 'day')?.key ?? 'name';

  // One bar per person (or source, status…): the figure added up over the days.
  const grouped = useMemo<Row[]>(() => {
    if (!data || !metric) return [];
    const sums = new Map<string, number>();
    for (const r of data.rows) sums.set(String(r[labelKey] ?? '—'), (sums.get(String(r[labelKey] ?? '—')) ?? 0) + Number(r[metric.key] ?? 0));
    return [...sums].map(([name, value]) => ({ name, value: Math.round(value * 10) / 10 })).sort((a, b) => b.value - a.value).slice(0, 25);
  }, [data, metric, labelKey]);

  const perDay = useMemo<Row[]>(() => {
    if (!data || !metric || !byDay) return [];
    const sums = new Map<string, number>();
    for (const r of data.rows) sums.set(String(r.day), (sums.get(String(r.day)) ?? 0) + Number(r[metric.key] ?? 0));
    return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day: day.slice(5), value }));
  }, [data, metric, byDay]);

  async function save(format: 'csv' | 'xlsx') {
    setBusy(true);
    setError(null);
    try {
      await download(path, { ...query, format });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The download failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (report.error) return <Notice tone="bad">{report.error.message}</Notice>;
  if (!data) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {numeric.length > 1 ? (
          <label className="flex items-center gap-2 text-sm text-muted">Chart<Select aria-label="Figure to chart" value={metric?.key ?? ''} onChange={(e) => setPick(e.target.value)} className="w-64">{numeric.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select></label>
        ) : <span />}
        {can('report.export') && (
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void save('csv')}><Download className="h-3.5 w-3.5" aria-hidden /> CSV</Button>
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void save('xlsx')}><Download className="h-3.5 w-3.5" aria-hidden /> Excel</Button>
          </div>
        )}
      </div>
      {error && <Notice tone="bad">{error}</Notice>}

      {data.rows.length === 0 ? <Card><Empty title="No data for this period">Try a longer date range.</Empty></Card> : (
        <>
          {metric && (
            <div className={byDay ? 'grid gap-4 lg:grid-cols-2' : ''}>
              <ChartCard title={`${metric.label}${byDay ? ' by person' : ''}`} rows={grouped} xKey="name" series={[{ key: 'value', label: metric.label }]} horizontal={grouped.length > 6} />
              {byDay && <ChartCard title={`${metric.label} by day`} rows={perDay} xKey="day" series={[{ key: 'value', label: metric.label }]} initial="area" />}
            </div>
          )}
          <Card className="overflow-hidden">
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-head text-xs uppercase tracking-wide text-muted">
                  <tr>{data.columns.map((c) => <th key={c.key} className={`px-4 py-2.5 font-semibold ${numeric.includes(c) ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.rows.map((r, i) => (
                    <tr key={i} className="hover:bg-mint-50">{data.columns.map((c) => <td key={c.key} className={`px-4 py-2.5 ${numeric.includes(c) ? 'tabular text-right' : ''}`}>{fmt(r[c.key])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
