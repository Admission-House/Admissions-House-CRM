'use client';

import { AlertTriangle, CalendarClock, CalendarDays, Inbox, LayoutDashboard, PhoneCall, PhoneMissed, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ChartCard, DonutChart, colorAt } from '@/components/charts';
import { Button, Input, Notice, Panel, Select, Spinner, cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

interface Dashboard {
  queues: Record<string, number>;
  unassigned: number;
  dueToday: number;
  total: number;
  byStatus: { status: string; leads: number }[];
  today: { calls: { total: number; connected: number; missed: number; talkSec: number }; overdueFollowUps: number };
  team: { userId: string; name: string; role: string; status: string; lastActive: string | null }[] | null;
}

interface Report<R> {
  title: string;
  columns: { key: string; label: string }[];
  rows: R[];
}

const QUEUE_LABEL: Record<string, string> = { fresh: 'Fresh', missed: 'Missed', followup: 'Follow-up', counselled: 'Counselled', fee_paid: 'Fee paid', closed: 'Closed' };
const TEAM_LABEL: Record<string, { label: string; color: string }> = {
  online: { label: 'Online', color: '#12a150' },
  on_call: { label: 'On a call', color: '#1d6fb8' },
  on_break: { label: 'On a break', color: '#e29a1a' },
  idle: { label: 'Idle', color: '#8a979b' },
  not_logged_in: { label: 'Not signed in', color: '#cfd8db' },
};

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'custom', label: 'Choose dates' },
] as const;
type Period = (typeof PERIODS)[number]['key'];

const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const talk = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);

function Kpi({ icon: Icon, label, value, hint, href, tone = 'brand' }: { icon: LucideIcon; label: string; value: number | string; hint?: string; href?: string; tone?: 'brand' | 'bad' | 'warn' | 'info' }) {
  const tones = { brand: 'bg-mint text-brand', bad: 'bg-bad-50 text-bad', warn: 'bg-warn-50 text-warn', info: 'bg-info-50 text-info' };
  const body = (
    <div className="h-full rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card transition hover:border-line-strong hover:shadow-md">
      <span className={cx('grid h-11 w-11 place-items-center rounded-full', tones[tone])}><Icon className="h-5 w-5" aria-hidden /></span>
      <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="tabular mt-1 text-[32px] font-bold leading-none text-ink">{value}</p>
      {hint && <p className="mt-2 text-xs text-subtle">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

export default function DashboardPage() {
  const { can } = useAuth();
  const [period, setPeriod] = useState<Period>('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const dates = useMemo(() => {
    if (period === 'custom') return from && to && from <= to ? { from, to } : null;
    const days = period === 'today' ? 0 : Number(period) - 1;
    const end = new Date();
    return { from: ymd(new Date(end.getTime() - days * 86_400_000)), to: ymd(end) };
  }, [period, from, to]);

  const dash = useApi<Dashboard>('/dashboard');
  const reports = can('report.read');
  const range = reports && dates ? dates : undefined;
  const perDay = useApi<Report<{ name: string; leads: number }>>(range ? '/reports/leads' : null, { groupBy: 'day', ...range });
  const bySource = useApi<Report<{ name: string; leads: number }>>(range ? '/reports/leads' : null, { groupBy: 'source', ...range });
  const calls = useApi<Report<{ name: string; total: number; connected: number; missed: number }>>(range ? '/reports/calls' : null, range);
  const tat = useApi<Report<{ name: string; avgMin: number | null; leads: number }>>(range ? '/reports/tat' : null, { groupBy: 'user', ...range });
  const followups = useApi<{ overdue: number; today: number; upcoming: number }>(can('followup.manage') ? '/followups/summary' : null);

  if (dash.loading && !dash.data) return <Spinner />;
  if (dash.error) return <Notice tone="bad">{dash.error.message}</Notice>;
  const d = dash.data;
  if (!d) return null;

  const team = d.team ? Object.entries(TEAM_LABEL).map(([key, v]) => ({ name: v.label, color: v.color, value: d.team!.filter((m) => m.status === key).length })) : null;
  const trend = (perDay.data?.rows ?? []).slice().reverse().map((r) => ({ day: shortDay(r.name), leads: r.leads }));

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-[32px] font-bold leading-tight tracking-tight text-brand"><LayoutDashboard className="h-7 w-7" aria-hidden />Dashboard</h1>
          <p className="mt-1.5 text-[15px] text-muted">Central overview of leads, calls and team performance</p>
        </div>
        {reports && (
          <div className="flex flex-wrap items-center gap-2.5">
            <label className="flex items-center gap-2 text-sm text-muted">
              <CalendarDays className="h-4 w-4" aria-hidden />
              <span className="sr-only">Period</span>
              <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="w-44">
                {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </label>
            {period === 'custom' && (
              <>
                <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-36" /></label>
                <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-36" /></label>
              </>
            )}
            <Button variant="secondary" onClick={() => { setPeriod('30'); setFrom(''); setTo(''); }}>Reset</Button>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <Kpi icon={Users} label="All leads" value={d.total} href="/leads" />
        <Kpi icon={Inbox} label="Fresh leads" value={d.queues.fresh ?? 0} hint={d.unassigned > 0 ? `${d.unassigned} not assigned` : undefined} href="/leads?queue=fresh" />
        <Kpi icon={CalendarClock} label="Follow-ups today" value={d.dueToday} tone="warn" href="/leads?followup=today" />
        <Kpi icon={AlertTriangle} label="Overdue" value={d.today.overdueFollowUps} tone={d.today.overdueFollowUps > 0 ? 'bad' : 'brand'} href="/leads?followup=overdue" />
        <Kpi icon={PhoneCall} label="Calls today" value={d.today.calls.total} tone="info" hint={`${d.today.calls.connected} connected · ${talk(d.today.calls.talkSec)}`} />
        <Kpi icon={PhoneMissed} label="Missed calls today" value={d.today.calls.missed} tone={d.today.calls.missed > 0 ? 'bad' : 'brand'} />
      </div>

      {reports && !dates && <div className="mt-4"><Notice tone="warn">Choose both dates to see the charts for your own period.</Notice></div>}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        {reports && (
          <ChartCard title="Leads received" caption="New leads per day in the chosen period" rows={trend} xKey="day" series={[{ key: 'leads', label: 'Leads' }]} initial="area" height={270} />
        )}
        <Panel title="LEADS BY STATUS" className="[&>div:first-child>h2]:text-sm [&>div:first-child>h2]:font-bold [&>div:first-child>h2]:uppercase [&>div:first-child>h2]:tracking-wide">
          <DonutChart data={d.byStatus.map((s, i) => ({ name: s.status, value: s.leads, color: colorAt(i) }))} centerLabel="leads" height={200} />
        </Panel>

        {reports && (
          <ChartCard title="Leads by source" caption="Where the leads in this period came from" rows={(bySource.data?.rows ?? []).map((r) => ({ name: r.name, leads: r.leads }))} xKey="name" series={[{ key: 'leads', label: 'Leads' }]} height={260} />
        )}
        <ChartCard title="Leads by queue" caption="Where every lead sits right now" rows={Object.entries(d.queues).map(([k, n]) => ({ name: QUEUE_LABEL[k] ?? k, leads: n }))} xKey="name" series={[{ key: 'leads', label: 'Leads', color: '#0f625e' }]} height={260} />

        {followups.data && (
          <ChartCard
            title="Follow-ups"
            caption="What is waiting to be done"
            rows={[{ name: 'Overdue', n: followups.data.overdue }, { name: 'Due today', n: followups.data.today }, { name: 'Upcoming', n: followups.data.upcoming }]}
            xKey="name"
            series={[{ key: 'n', label: 'Follow-ups', color: '#e29a1a' }]}
            height={240}
          />
        )}
        {team && (
          <Panel title="TEAM RIGHT NOW" className="[&>div:first-child>h2]:text-sm [&>div:first-child>h2]:font-bold [&>div:first-child>h2]:uppercase [&>div:first-child>h2]:tracking-wide">
            <DonutChart data={team} centerLabel="people" height={200} />
          </Panel>
        )}

        {reports && (
          <ChartCard
            title="Calls by counsellor"
            caption="Connected, missed and the rest, in the chosen period"
            rows={(calls.data?.rows ?? []).map((r) => ({ name: r.name, answered: r.connected, missed: r.missed, other: Math.max(0, r.total - r.connected - r.missed) }))}
            xKey="name"
            stacked
            series={[{ key: 'answered', label: 'Connected', color: '#12a150' }, { key: 'missed', label: 'Missed', color: '#d6393f' }, { key: 'other', label: 'Not picked or other', color: '#cfd8db' }]}
            height={260}
            className="xl:col-span-1"
          />
        )}
        {reports && (
          <ChartCard
            title="Time to first call"
            caption="Average hours from a lead arriving to the first call"
            rows={(tat.data?.rows ?? []).filter((r) => r.avgMin !== null).map((r) => ({ name: r.name, hours: Math.round((r.avgMin! / 60) * 10) / 10 }))}
            xKey="name"
            series={[{ key: 'hours', label: 'Hours', color: '#1d6fb8' }]}
            height={260}
          />
        )}
      </div>
    </>
  );
}
