'use client';

import { useMemo, useState } from 'react';
import { PageHeader, Select, Tabs, Input } from '@/components/ui';
import { ReportView } from '@/components/reports/report-view';
import { TeamNow } from '@/components/reports/team-now';

const TABS = [
  { key: 'team', label: 'Team now' },
  { key: 'leads', label: 'Leads' },
  { key: 'calls', label: 'Calls' },
  { key: 'productivity', label: 'Productivity' },
  { key: 'tat', label: 'Time to first call' },
  { key: 'activity', label: 'Activity' },
  { key: 'attendance', label: 'Attendance' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** Dates are the viewer's own calendar days, not UTC days. */
const ymd = (d: Date) => d.toLocaleDateString('en-CA');
const today = () => ymd(new Date());
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));

const LEAD_GROUPS = [
  { key: 'source', label: 'By source' },
  { key: 'status', label: 'By status' },
  { key: 'assignee', label: 'By counsellor' },
  { key: 'day', label: 'By day' },
];

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('team');
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(today());
  const [month, setMonth] = useState(today().slice(0, 7));
  const [leadGroup, setLeadGroup] = useState('source');
  const [tatGroup, setTatGroup] = useState('user');

  const range = useMemo(() => ({ from, to }), [from, to]);
  const query = useMemo(() => {
    switch (tab) {
      case 'leads': return { ...range, groupBy: leadGroup };
      case 'tat': return { ...range, groupBy: tatGroup };
      case 'attendance': return { month };
      default: return range;
    }
  }, [tab, range, leadGroup, tatGroup, month]);

  return (
    <>
      <PageHeader title="Reports" subtitle="Charts and tables for your own work, or your team's. Download any of them as CSV or Excel." />
      <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={[...TABS]} value={tab} onChange={setTab} label="Reports" /></div>

      {tab === 'team' ? <div className="mt-4"><TeamNow /></div> : <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        {tab === 'attendance' ? (
          <label className="flex items-center gap-2 text-sm text-muted">Month<Input type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" /></label>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm text-muted">From<Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="w-40" /></label>
            <label className="flex items-center gap-2 text-sm text-muted">To<Input type="date" value={to} min={from} max={today()} onChange={(e) => e.target.value && setTo(e.target.value)} className="w-40" /></label>
          </>
        )}
        {tab === 'leads' && <Select aria-label="Group leads" value={leadGroup} onChange={(e) => setLeadGroup(e.target.value)} className="w-44">{LEAD_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}</Select>}
        {tab === 'tat' && <Select aria-label="Group by" value={tatGroup} onChange={(e) => setTatGroup(e.target.value)} className="w-44"><option value="user">By counsellor</option><option value="source">By source</option></Select>}
      </div>

      <ReportView key={`${tab}-${JSON.stringify(query)}`} path={`/reports/${tab}`} query={query} chartFirst={tab === 'leads' ? 'leads' : undefined} />
      </>}
    </>
  );
}
