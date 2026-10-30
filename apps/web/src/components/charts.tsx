'use client';

import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cx } from '@/components/ui';

/** Chart colours, in the order series are assigned. The first two are the brand teals. */
export const PALETTE = ['#00b9a1', '#0f625e', '#1d6fb8', '#e29a1a', '#6b5bd2', '#d6393f', '#12a150', '#8a979b'] as const;
export const colorAt = (i: number) => PALETTE[i % PALETTE.length]!;

const AXIS = { fontSize: 11, fill: '#5b6b70' } as const;
const GRID = '#e8eef0';

function EmptyChart({ height, message = 'Nothing to show for this period yet' }: { height: number; message?: string }) {
  return <div style={{ height }} className="grid place-items-center text-xs text-subtle">{message}</div>;
}

const tooltipStyle = { fontSize: 12, borderRadius: 6, border: '1px solid #e1e7e9', boxShadow: '0 4px 14px rgb(20 38 43 / 0.08)' };

export interface Slice {
  name: string;
  value: number;
  color?: string;
}

/** A ring with the total in the middle and a legend that shows each part and its share. */
export function DonutChart({ data, height = 190, centerLabel = 'Total', className }: { data: Slice[]; height?: number; centerLabel?: string; className?: string }) {
  const shown = data.filter((d) => d.value > 0);
  const total = shown.reduce((n, d) => n + d.value, 0);
  if (total === 0) return <EmptyChart height={height} />;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-6 gap-y-3', className)}>
      <div className="relative shrink-0" style={{ width: height, height }} role="img" aria-label={`${centerLabel}: ${total}. ${shown.map((d) => `${d.name} ${d.value}`).join(', ')}`}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={shown} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="94%" paddingAngle={shown.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {shown.map((d, i) => <Cell key={d.name} fill={d.color ?? colorAt(i)} />)}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [`${Number(v)} (${Math.round((Number(v) / total) * 100)}%)`, String(n)]} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <p className="tabular text-2xl font-semibold leading-none text-ink">{total}</p>
            <p className="mt-1 text-xs text-muted">{centerLabel}</p>
          </div>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-1.5 text-sm">
        {shown.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.color ?? colorAt(i) }} aria-hidden />
            <span className="flex-1 truncate text-ink">{d.name}</span>
            <span className="tabular font-medium text-ink">{d.value}</span>
            <span className="tabular w-9 text-right text-xs text-muted">{Math.round((d.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Series {
  key: string;
  label: string;
  color?: string;
}

/** Columns or horizontal bars, one or several series, optionally stacked. */
export type Row = Record<string, string | number | null>;

export function BarsChart({
  data, xKey, series, height = 240, stacked, horizontal, yLabel, hideLegend,
}: { data: Row[]; xKey: string; series: Series[]; height?: number; stacked?: boolean; horizontal?: boolean; yLabel?: string; hideLegend?: boolean }) {
  if (data.length === 0) return <EmptyChart height={height} />;
  const h = horizontal ? Math.max(height, data.length * 34 + 30) : height;
  return (
    <div style={{ height: h }} role="img" aria-label={`Bar chart of ${series.map((s) => s.label).join(', ')} by ${xKey}`}>
      <ResponsiveContainer>
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, left: horizontal ? 8 : -8, bottom: 0 }} barCategoryGap={horizontal ? 8 : '24%'}>
          <CartesianGrid stroke={GRID} vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey={xKey} tick={AXIS} axisLine={false} tickLine={false} width={110} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={44} label={yLabel ? { value: yLabel, angle: -90, position: 'insideLeft', style: AXIS } : undefined} />
            </>
          )}
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgb(0 185 161 / 0.07)' }} />
          {series.length > 1 && !hideLegend && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color ?? colorAt(i)} stackId={stacked ? 'a' : undefined} radius={stacked ? 0 : [3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A trend over time, filled underneath. */
export function TrendChart({ data, xKey, series, height = 240, hideLegend }: { data: Row[]; xKey: string; series: Series[]; height?: number; hideLegend?: boolean }) {
  if (data.length === 0) return <EmptyChart height={height} />;
  return (
    <div style={{ height }} role="img" aria-label={`Trend of ${series.map((s) => s.label).join(', ')} over time`}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color ?? colorAt(i)} stopOpacity={0.28} />
                <stop offset="100%" stopColor={s.color ?? colorAt(i)} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} width={44} />
          <Tooltip contentStyle={tooltipStyle} />
          {series.length > 1 && !hideLegend && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />}
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? colorAt(i)} strokeWidth={2} fill={`url(#g-${s.key})`} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ------------------------------------------------------------ chart card

type Kind = 'bar' | 'list' | 'area';
const KIND_LABEL: Record<Kind, string> = { bar: 'Bar', list: 'List', area: 'Area' };

/**
 * A titled chart that the viewer can switch between bars, a plain list of the numbers, and an area
 * view. The legend sits above it, as in the reports the team already knows.
 */
export function ChartCard({
  title, caption, rows, xKey, series, stacked, horizontal, kinds = ['bar', 'list', 'area'], initial = 'bar', height = 260, actions, className,
}: {
  title: string;
  caption?: string;
  rows: Row[];
  xKey: string;
  series: Series[];
  stacked?: boolean;
  horizontal?: boolean;
  kinds?: Kind[];
  initial?: Kind;
  height?: number;
  actions?: React.ReactNode;
  className?: string;
}) {
  const [kind, setKind] = useState<Kind>(initial);
  return (
    <section className={cx('rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{title}</h2>
        <div className="flex items-center gap-2">
          {actions}
          {kinds.length > 1 && (
            <div role="group" aria-label={`${title} view`} className="flex rounded-lg border border-line bg-head p-0.5">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={cx('rounded-md px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors', kind === k ? 'bg-brand text-white' : 'text-muted hover:text-ink')}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {caption && <p className="mt-1.5 text-sm text-muted">{caption}</p>}
      {series.length > 1 && (
        <ul className="mt-4 flex flex-wrap justify-end gap-x-5 gap-y-1">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color ?? colorAt(i) }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        {kind === 'bar' && <BarsChart data={rows} xKey={xKey} series={series} stacked={stacked} horizontal={horizontal} height={height} hideLegend />}
        {kind === 'area' && <TrendChart data={rows} xKey={xKey} series={series} height={height} hideLegend />}
        {kind === 'list' && (
          rows.length === 0 ? <EmptyChart height={height} /> : (
            <div className="max-h-80 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-head text-xs uppercase tracking-wide text-muted">
                  <tr><th className="px-3 py-2 font-semibold">{xKey === 'name' ? 'Name' : xKey}</th>{series.map((s) => <th key={s.key} className="px-3 py-2 text-right font-semibold">{s.label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r, i) => (
                    <tr key={i}><td className="px-3 py-2">{String(r[xKey] ?? '')}</td>{series.map((s) => <td key={s.key} className="tabular px-3 py-2 text-right font-medium">{r[s.key] ?? '—'}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </section>
  );
}
