'use client';

import { Coffee, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Select, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Today {
  tracked: boolean;
  checkedIn?: boolean;
  record?: { checkInAt: string; checkOutAt: string | null; lateMinutes: number } | null;
  onBreak?: { startedAt: string; type: { name: string; allowedMinutes: number } } | null;
  breakMinutesToday?: number;
  shift?: { start: string; end: string; idleTimeoutMin: number } | null;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();

/**
 * For people whose attendance is tracked: when they signed in today, and the break controls. Signing
 * in from the office is the attendance, so there is nothing to press to check in.
 */
export function WorkStatus() {
  const { can } = useAuth();
  const today = useApi<Today>(can('attendance.self') ? '/attendance/me/today' : null);
  const types = useApi<{ id: string; name: string; allowedMinutes: number }[]>(can('attendance.self') ? '/attendance/break-types' : null);
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);

  const t = today.data;
  const onBreak = t?.onBreak ?? null;

  // The break timer ticks once a minute, only while a break is running.
  useEffect(() => {
    if (!onBreak) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [onBreak]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!t?.tracked) return null;

  async function act(path: string, body?: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      today.reload();
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const minutes = onBreak ? Math.max(0, Math.floor((now - new Date(onBreak.startedAt).getTime()) / 60_000)) : 0;
  const over = onBreak ? minutes > onBreak.type.allowedMinutes : false;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cx(
          'flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors',
          onBreak ? (over ? 'border-bad/40 bg-bad-50 text-bad' : 'border-warn/40 bg-warn-50 text-warn') : 'border-line-strong bg-surface text-ink hover:bg-head',
        )}
      >
        {onBreak ? <Coffee className="h-3.5 w-3.5" aria-hidden /> : <LogIn className="h-3.5 w-3.5 text-ok" aria-hidden />}
        {onBreak ? `${onBreak.type.name} · ${minutes} of ${onBreak.type.allowedMinutes} min` : t.record ? `In since ${clock(t.record.checkInAt)}` : 'Not signed in'}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-line bg-surface p-4 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Today</p>
          {t.record && (
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Signed in</dt><dd className="font-medium">{fmtDateTime(t.record.checkInAt)}</dd></div>
              {t.record.lateMinutes > 0 && <div className="flex justify-between"><dt className="text-muted">Late by</dt><dd className="font-medium text-warn">{t.record.lateMinutes} min</dd></div>}
              <div className="flex justify-between"><dt className="text-muted">Breaks so far</dt><dd className="font-medium">{t.breakMinutesToday ?? 0} min</dd></div>
              {t.shift && <div className="flex justify-between"><dt className="text-muted">Shift</dt><dd className="font-medium">{t.shift.start} to {t.shift.end}</dd></div>}
            </dl>
          )}
          {t.shift && <p className="mt-3 text-xs text-subtle">You are signed out after {t.shift.idleTimeoutMin} minutes without activity. A break does not pause this.</p>}
          {error && <p role="alert" className="mt-3 text-xs text-bad">{error}</p>}
          <div className="mt-4 border-t border-line pt-4">
            {onBreak ? (
              <Button className="w-full" loading={busy} onClick={() => void act('/attendance/breaks/end')}>End break</Button>
            ) : t.checkedIn ? (
              <div className="flex gap-2">
                <Select aria-label="Kind of break" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                  <option value="">Choose a break</option>
                  {types.data?.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.allowedMinutes} min)</option>)}
                </Select>
                <Button variant="secondary" disabled={!typeId} loading={busy} onClick={() => void act('/attendance/breaks/start', { breakTypeId: typeId })}>Start</Button>
              </div>
            ) : (
              <p className="text-xs text-muted">Sign in from the office to start your day.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
