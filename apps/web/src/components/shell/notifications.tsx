'use client';

import { Bell, CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Spinner, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { fromNow } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

const REFUSED_REASON: Record<string, string> = {
  network: 'wrong network', gps_missing: 'no location', gps_mocked: 'fake location', gps_inaccurate: 'location not exact', gps_far: 'too far from the office', not_configured: 'office not set up',
};

/** One line of text for each kind of notification the API sends. */
export function describeNotification(n: Notification): { title: string; detail?: string; href?: string } {
  const p = n.payload;
  const lead = typeof p.leadId === 'string' ? `/leads/${p.leadId}` : undefined;
  const name = typeof p.name === 'string' ? p.name : 'a lead';
  switch (p.event) {
    case 'lead_assigned': return { title: `New lead assigned: ${name}`, detail: typeof p.source === 'string' ? `From ${p.source}` : undefined, href: lead };
    case 'lead_unassigned': return { title: `Nobody was available for ${name}`, detail: 'It is waiting in the unassigned pool', href: lead };
    case 'resource_download': return { title: `${name} asked to download: ${String(p.resource ?? 'a resource')}`, detail: typeof p.phone === 'string' ? p.phone : undefined, href: lead };
    case 'repeat_enquiry': return { title: `${name} enquired again`, href: lead };
    case 'followup_due': return { title: `Follow-up due: ${name}`, detail: typeof p.note === 'string' ? p.note : undefined, href: lead };
    case 'missed_call': return { title: `Missed call from ${name}`, href: lead };
    case 'import_finished': return { title: `Import finished: ${String(p.fileName ?? '')}`, detail: `${String(p.created ?? 0)} new, ${String(p.attached ?? 0)} repeats, ${String(p.failed ?? 0)} failed` };
    case 'leads_imported': return { title: `${String(p.count ?? 0)} leads were added for you`, detail: typeof p.fileName === 'string' ? p.fileName : undefined, href: '/leads' };
    case 'leads_assigned': return { title: `${String(p.count ?? 0)} leads were given to you`, detail: typeof p.by === 'string' ? `By ${p.by}` : undefined, href: '/leads' };
    case 'leave_requested': return { title: `${String(p.userName ?? 'Someone')} asked for leave`, detail: `${String(p.leaveType ?? '')}, ${String(p.fromDate ?? '')}${p.toDate && p.toDate !== p.fromDate ? ` to ${String(p.toDate)}` : ''}`, href: '/leave' };
    case 'leave_decided': return { title: `Your leave was ${p.decision === 'approved' ? 'approved' : 'turned down'}`, detail: [typeof p.decidedBy === 'string' ? `By ${p.decidedBy}` : '', typeof p.note === 'string' ? p.note : ''].filter(Boolean).join('. ') || undefined, href: '/leave' };
    case 'idle_logout': return { title: `${String(p.userName ?? 'Someone')} was signed out for inactivity`, detail: `No activity for ${String(p.idleMinutes ?? 30)} minutes`, href: '/attendance' };
    case 'login_refused': return { title: `${String(p.userName ?? 'Someone')} was refused at sign-in`, detail: `Not at the office (${REFUSED_REASON[String(p.reason)] ?? String(p.reason ?? 'outside the office')})`, href: '/attendance' };
    case 'forced_logout': return { title: `${String(p.userName ?? 'Someone')} was signed out by an admin`, href: '/settings/sessions' };
    case 'attendance_exception': return { title: `Attendance marked by hand for ${String(p.userName ?? 'someone')}`, detail: [typeof p.date === 'string' ? p.date : '', typeof p.reason === 'string' ? p.reason : ''].filter(Boolean).join(': ') || undefined, href: '/attendance' };
    default: return { title: n.type.replace(/_/g, ' ') };
  }
}

export function NotificationBell() {
  const router = useRouter();
  const count = useApi<{ unread: number }>('/notifications/unread-count');
  const [open, setOpen] = useState(false);
  const list = useApi<Page<Notification>>(open ? '/notifications' : null, { limit: 15 });
  const box = useRef<HTMLDivElement>(null);
  const unread = count.data?.unread ?? 0;

  // A new notification is noticed within a minute without the person doing anything.
  useEffect(() => {
    const id = setInterval(count.reload, 60_000);
    return () => clearInterval(id);
  }, [count.reload]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function markAllRead() {
    await api('/notifications/read', { method: 'POST', body: { all: true } });
    count.reload();
    list.reload();
  }

  async function openOne(n: Notification) {
    const { href } = describeNotification(n);
    if (!n.readAt) {
      await api('/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => undefined);
      count.reload();
    }
    setOpen(false);
    if (href) router.push(href);
  }

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'} className="relative grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-head hover:text-ink">
        <Bell className="h-[18px] w-[18px]" aria-hidden />
        {unread > 0 && <span className="tabular absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-xs font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-96 max-w-[92vw] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && <button onClick={() => void markAllRead()} className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><CheckCheck className="h-3.5 w-3.5" aria-hidden /> Mark all read</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {list.loading && !list.data ? <Spinner /> : (list.data?.items.length ?? 0) === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">You are all caught up.</p>
            ) : (
              <ul className="divide-y divide-line">
                {list.data!.items.map((n) => {
                  const t = describeNotification(n);
                  return (
                    <li key={n.id}>
                      <button onClick={() => void openOne(n)} className={cx('flex w-full gap-3 px-4 py-3 text-left hover:bg-head', !n.readAt && 'bg-mint-50')}>
                        <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-teal-600')} aria-hidden />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-ink">{t.title}</span>
                          {t.detail && <span className="block truncate text-xs text-muted">{t.detail}</span>}
                          <span className="mt-0.5 block text-xs text-subtle">{fromNow(n.createdAt)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2.5 text-center text-sm font-medium text-brand-600 hover:bg-head">See all notifications</Link>
        </div>
      )}
    </div>
  );
}
