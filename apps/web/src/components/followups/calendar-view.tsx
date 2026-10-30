'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button, Card, Notice, cx } from '@/components/ui';
import { fmtPhone } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export interface CalendarFollowUp {
  id: string;
  dueAt: string;
  note: string | null;
  owner: { id: string; name: string };
  lead: { id: string; name: string; phone: string };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const key = (d: Date) => d.toLocaleDateString('en-CA');

/** A month at a glance: every open follow-up on its day. Pick a day to see it. */
export function CalendarView({ userId }: { userId: string }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [picked, setPicked] = useState<string>(() => key(new Date()));
  const base = useMemo(() => ({ limit: 100, userId: userId || undefined }), [userId]);
  const overdue = useApi<Page<CalendarFollowUp>>('/followups', useMemo(() => ({ ...base, bucket: 'overdue' }), [base]));
  const today = useApi<Page<CalendarFollowUp>>('/followups', useMemo(() => ({ ...base, bucket: 'today' }), [base]));
  const upcoming = useApi<Page<CalendarFollowUp>>('/followups', useMemo(() => ({ ...base, bucket: 'upcoming' }), [base]));

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarFollowUp[]>();
    for (const f of [...(overdue.data?.items ?? []), ...(today.data?.items ?? []), ...(upcoming.data?.items ?? [])]) {
      const k = key(new Date(f.dueAt));
      map.set(k, [...(map.get(k) ?? []), f]);
    }
    for (const list of map.values()) list.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return map;
  }, [overdue.data, today.data, upcoming.data]);

  const lead = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7; // the grid starts on Monday
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => (i < lead || i >= lead + days ? null : new Date(month.getFullYear(), month.getMonth(), i - lead + 1)));
  const todayKey = key(new Date());
  const chosen = byDay.get(picked) ?? [];
  const error = overdue.error ?? today.error ?? upcoming.error;
  const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Earlier month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head"><ChevronLeft className="h-5 w-5" /></button>
            <Button variant="secondary" size="sm" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setPicked(todayKey); }}>Today</Button>
            <button type="button" aria-label="Later month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-head"><ChevronRight className="h-5 w-5" /></button>
          </div>
        </div>
        {error ? <div className="p-4"><Notice tone="bad">{error.message}</Notice></div> : (
          <div className="grid grid-cols-7">
            {WEEKDAYS.map((w) => <div key={w} className="border-b border-line bg-head px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-muted">{w}</div>)}
            {cells.map((d, i) => {
              const k = d ? key(d) : '';
              const list = d ? byDay.get(k) ?? [] : [];
              return (
                <button
                  key={i}
                  type="button"
                  disabled={!d}
                  onClick={() => setPicked(k)}
                  aria-label={d ? `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}, ${list.length} follow-ups` : undefined}
                  className={cx('min-h-24 border-b border-r border-line p-1.5 text-left align-top transition-colors', d ? 'hover:bg-mint-50' : 'bg-canvas', k === picked && 'bg-mint-soft')}
                >
                  {d && (
                    <>
                      <span className={cx('grid h-6 w-6 place-items-center rounded-full text-xs font-semibold', k === todayKey ? 'bg-brand text-white' : 'text-ink')}>{d.getDate()}</span>
                      {list.slice(0, 2).map((f) => <span key={f.id} className={cx('mt-1 block truncate rounded px-1.5 py-0.5 text-xs', new Date(f.dueAt).getTime() < Date.now() ? 'bg-bad-50 text-bad' : 'bg-info-50 text-info')}>{f.lead.name}</span>)}
                      {list.length > 2 && <span className="mt-1 block px-1.5 text-xs font-medium text-muted">+{list.length - 2} more</span>}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="h-fit overflow-hidden">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-base font-semibold">{new Date(`${picked}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          <p className="text-xs text-muted">{chosen.length === 0 ? 'Nothing is booked for this day' : `${chosen.length} follow-up${chosen.length === 1 ? '' : 's'}`}</p>
        </div>
        <ul className="divide-y divide-line">
          {chosen.map((f) => (
            <li key={f.id} className="px-4 py-3">
              <Link href={`/leads/${f.lead.id}`} className="font-medium text-ink hover:text-brand-600">{f.lead.name}</Link>
              <p className="tabular text-xs text-muted">{fmtPhone(f.lead.phone)} · {clock(f.dueAt)} · {f.owner.name}</p>
              {f.note && <p className="mt-1 text-sm text-muted">{f.note}</p>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
