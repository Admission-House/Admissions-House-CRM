'use client';

import { useEffect } from 'react';
import { Badge, Card, Empty, Notice, Spinner } from '@/components/ui';
import { fromNow } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Member { userId: string; name: string; role: string; status: string; lastActive: string | null }
interface Report { rows: Member[] }

const STATUS: Record<string, { label: string; tone: 'ok' | 'info' | 'warn' | 'neutral' }> = {
  online: { label: 'Online', tone: 'ok' },
  on_call: { label: 'On a call', tone: 'info' },
  on_break: { label: 'On a break', tone: 'warn' },
  idle: { label: 'Idle', tone: 'neutral' },
  not_logged_in: { label: 'Not signed in', tone: 'neutral' },
};
const ORDER = ['on_call', 'online', 'on_break', 'idle', 'not_logged_in'];

/** Who is working right now. It looks again every half minute, so the page is a live view. */
export function TeamNow() {
  const team = useApi<Report>('/reports/team-status');
  const reload = team.reload;

  useEffect(() => {
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  if (team.error) return <Notice tone="bad">{team.error.message}</Notice>;
  if (!team.data) return <Spinner />;
  const rows = [...team.data.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const count = (s: string) => rows.filter((r) => r.status === s).length;

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ORDER.map((s) => (
          <li key={s}><Card className="p-4"><p className="text-xs font-semibold uppercase tracking-wide text-muted">{STATUS[s]!.label}</p><p className="tabular mt-1 text-2xl font-bold text-brand">{count(s)}</p></Card></li>
        ))}
      </ul>
      {rows.length === 0 ? <Card><Empty title="No one to show" /></Card> : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2.5 font-semibold">Name</th><th className="px-3 py-2.5 font-semibold">Role</th><th className="px-3 py-2.5 font-semibold">Now</th><th className="px-3 py-2.5 font-semibold">Last active</th></tr></thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.userId} className="hover:bg-mint-50">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-3 py-3 text-muted">{r.role}</td>
                  <td className="px-3 py-3"><Badge tone={STATUS[r.status]?.tone ?? 'neutral'}>{STATUS[r.status]?.label ?? r.status}</Badge></td>
                  <td className="px-3 py-3 text-muted">{r.lastActive ? fromNow(r.lastActive) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-muted">Updates by itself every 30 seconds. Idle means no activity for 10 minutes.</p>
    </div>
  );
}
