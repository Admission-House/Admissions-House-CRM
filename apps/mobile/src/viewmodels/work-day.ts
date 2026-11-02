import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { BreakType, Dashboard, Today } from '@/models/types';

/** The day at a glance: attendance state, breaks, and today's numbers. */
export function useWorkDayViewModel(canTrack: boolean) {
  const today = useApi<Today>(canTrack ? '/attendance/me/today' : null);
  const types = useApi<BreakType[]>(canTrack ? '/attendance/break-types' : null);
  const dash = useApi<Dashboard>('/dashboard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const onBreak = !!today.data?.onBreak;
  useEffect(() => {
    if (!onBreak) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [onBreak]);

  async function act(path: string, body?: object) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      today.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const startBreak = (breakTypeId: string) => act('/attendance/breaks/start', { breakTypeId });
  const endBreak = () => act('/attendance/breaks/end');
  const breakMinutes = today.data?.onBreak ? Math.max(0, Math.floor((now - new Date(today.data.onBreak.startedAt).getTime()) / 60_000)) : 0;

  const refresh = () => { today.reload(); dash.reload(); };
  return { today, types, dash, busy, error, startBreak, endBreak, breakMinutes, refresh };
}
