'use client';

import { Coffee, LogIn } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, cx } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Today {
  tracked: boolean;
  checkedIn?: boolean;
  record?: { checkInAt: string; checkOutAt: string | null; lateMinutes: number } | null;
  onBreak?: { startedAt: string; type: { id: string; name: string; allowedMinutes: number } } | null;
  breakMinutesToday?: number;
  breaks?: { id: string; name: string; allowedMinutes: number; usedMinutes: number }[];
  hardLimitMinutes?: number;
  serverNow?: string;
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
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);
  // How far this computer's clock is from the server's, taken each time the answer arrives, so the counting is right on any computer.
  const skew = useRef(0);

  const t = today.data;
  const onBreak = t?.onBreak ?? null;
  const answeredAt = t?.serverNow;
  useEffect(() => { if (answeredAt) skew.current = new Date(answeredAt).getTime() - Date.now(); }, [answeredAt]);

  // The break timer ticks every few seconds, only while a break is running, and again as soon as the person comes back to this tab.
  useEffect(() => {
    if (!onBreak) return;
    const tick = () => setNow(Date.now() + skew.current);
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 10_000);
    const back = () => { if (!document.hidden) { tick(); today.reload(); } };
    document.addEventListener('visibilitychange', back);
    return () => { clearTimeout(first); clearInterval(id); document.removeEventListener('visibilitychange', back); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBreak?.startedAt, answeredAt]);

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
  // The allowance is the day's total of this kind of break (several short breaks add up), so compare the total, not the running break alone.
  const kindBefore = onBreak ? (t?.breaks?.find((b) => b.id === onBreak.type.id)?.usedMinutes ?? 0) : 0;
  // All of today's break time: what was counted when the answer arrived, plus what has passed since.
  const sinceAnswer = t?.serverNow ? Math.max(0, Math.floor((now - new Date(t.serverNow).getTime()) / 60_000)) : 0;
  const hardLimit = t?.hardLimitMinutes ?? 100;
  const dayUsed = (t?.breakMinutesToday ?? 0) + (onBreak ? sinceAnswer : 0);
  const signOutIn = Math.max(0, hardLimit - dayUsed);
  const kindUsed = kindBefore + (onBreak ? sinceAnswer : 0);
  const over = onBreak ? kindUsed > onBreak.type.allowedMinutes : false;

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
        {onBreak ? (over ? `Over ${onBreak.type.allowedMinutes} min · signs out in ${signOutIn} min` : `${onBreak.type.name} · ${kindUsed} of ${onBreak.type.allowedMinutes} min today`) : t.record ? `In since ${clock(t.record.checkInAt)}` : 'Not signed in'}
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
          {t.shift && <p className="mt-3 text-xs text-subtle">You are signed out after {t.shift.idleTimeoutMin} minutes without activity. On a break you are not signed out for being quiet. Once your breaks add up to {t.hardLimitMinutes ?? 100} minutes in a day you are signed out.</p>}
          {error && <p role="alert" className="mt-3 text-xs text-bad">{error}</p>}
          <div className="mt-4 border-t border-line pt-4">
            {onBreak ? (
              <>
                <p className={cx('mb-3 text-sm', over ? 'font-medium text-bad' : 'text-muted')}>
                  {over
                    ? `You have used more than the ${onBreak.type.allowedMinutes} minutes allowed for the day. Your supervisors have been told. You are signed out in ${signOutIn} min if you do not end it.`
                    : `This break: ${minutes} min. Today: ${kindUsed} of ${onBreak.type.allowedMinutes} min used, ${Math.max(0, onBreak.type.allowedMinutes - kindUsed)} left. Take it in as many parts as you like.`}
                </p>
                <Button className="w-full" loading={busy} onClick={() => void act('/attendance/breaks/end')}>End break</Button>
              </>
            ) : t.checkedIn ? (
              <ul className="space-y-2" aria-label="Breaks">
                {(t.breaks ?? []).map((b) => {
                  const left = Math.max(0, b.allowedMinutes - b.usedMinutes);
                  return (
                    <li key={b.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{b.name}</p>
                        <p className="text-xs text-muted">{left > 0 ? `${b.usedMinutes} of ${b.allowedMinutes} min used today, ${left} left` : `${b.allowedMinutes} min used. More time is reported to your supervisors; you are signed out at ${hardLimit} min.`}</p>
                      </div>
                      <Button variant="secondary" size="sm" disabled={(t.breakMinutesToday ?? 0) >= hardLimit} loading={busy} onClick={() => void act('/attendance/breaks/start', { breakTypeId: b.id })}>Start</Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-muted">Sign in from the office to start your day.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
