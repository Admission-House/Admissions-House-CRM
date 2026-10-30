'use client';

import { Laptop, Smartphone } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Notice, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime, fromNow } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Session {
  id: string;
  current: boolean;
  clientType: string;
  ip: string | null;
  userAgent: string | null;
  signedInAt: string;
  lastActiveAt: string;
  user?: { id: string; name: string; role: string };
}

/** A short, readable name for a browser or phone from its user-agent text. */
function deviceName(ua: string | null, clientType: string): string {
  if (clientType === 'mobile') return 'Mobile app';
  if (!ua) return 'Web browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * The places someone is signed in, with a button to end each. `all` shows everyone's, for those who
 * manage users; otherwise only the signed-in person's own.
 */
export function SessionsList({ all, userId: fixedUser }: { all?: boolean; userId?: string }) {
  const [picked, setPicked] = useState('');
  const userId = fixedUser ?? picked;
  const people = useApi<Page<{ id: string; name: string }>>(all && !fixedUser ? '/users' : null, useMemo(() => ({ limit: 100, status: 'active' }), []));
  const list = useApi<Session[]>(all ? '/auth/sessions/all' : '/auth/sessions', useMemo(() => (all && userId ? { userId } : {}), [all, userId]));
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);

  async function end(s: Session) {
    setError(null);
    setEnded(null);
    try {
      await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
      setEnded(s.user ? `${s.user.name} was signed out of that device.` : 'That device was signed out.');
      list.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    }
  }

  return (
    <div className="space-y-4">
      {all && !fixedUser && people.data && (
        <Select aria-label="Person" value={picked} onChange={(e) => setPicked(e.target.value)} className="w-64"><option value="">Everyone</option>{people.data.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {ended && <Notice tone="ok">{ended}</Notice>}
      {list.error ? <Notice tone="bad">{list.error.message}</Notice> : !list.data ? <Spinner /> : list.data.length === 0 ? <Empty title="No one is signed in" /> : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {list.data.map((s) => {
            const Icon = s.clientType === 'mobile' ? Smartphone : Laptop;
            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-head text-brand"><Icon className="h-5 w-5" aria-hidden /></span>
                  <div>
                    <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">{s.user ? `${s.user.name}` : deviceName(s.userAgent, s.clientType)}{s.user && <span className="font-normal text-muted">· {deviceName(s.userAgent, s.clientType)}</span>}{s.current && <Badge tone="ok">This device</Badge>}</p>
                    <p className="text-xs text-muted">{s.ip ? `${s.ip} · ` : ''}signed in {fmtDateTime(s.signedInAt)} · last active {fromNow(s.lastActiveAt)}</p>
                  </div>
                </div>
                {!s.current && <Button size="sm" variant="danger" onClick={() => void end(s)}>Sign out</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
