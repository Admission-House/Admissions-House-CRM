'use client';

import { Mic, PhoneIncoming, PhoneOff, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { CallKind } from '@/lib/communications';
import { useRealtime, useRealtimeStatus } from '@/lib/realtime';
import { useApi } from '@/lib/use-api';

interface Ringing {
  sessionId: string;
  kind: CallKind;
  type: 'call' | 'meeting';
  title: string | null;
  fromName: string;
  leadId: string | null;
  leadName: string | null;
  secondsLeft: number;
}

/**
 * A call that is ringing for this person, on whatever screen they are on. It appears the moment the server
 * says so (the live connection), with a slow check as a fallback, and disappears when it is answered, turned
 * down or missed. A phone that is closed or a browser that has paused this tab cannot be rung: the
 * notification bell and the phone alert carry the call then.
 */
export function IncomingCalls() {
  const { can } = useAuth();
  const allowed = can('video.host');
  const router = useRouter();
  const ringing = useApi<Ringing[]>(allowed ? '/communications/incoming' : null);
  const live = useRealtimeStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(new Set<string>());

  const reload = ringing.reload;
  useRealtime(['call'], reload, 500);
  useEffect(() => {
    if (!allowed) return;
    const id = setInterval(reload, live ? 20_000 : 5_000);
    return () => clearInterval(id);
  }, [allowed, live, reload]);

  // A desktop alert for a new ring, when the person has allowed them and the tab is not in front.
  useEffect(() => {
    for (const r of ringing.data ?? []) {
      if (shown.current.has(r.sessionId)) continue;
      shown.current.add(r.sessionId);
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
          const n = new Notification(`Incoming ${r.kind === 'voice' ? 'voice' : 'video'} call from ${r.fromName}`, { body: r.leadName ? `About ${r.leadName}` : r.title ?? undefined, tag: r.sessionId });
          n.onclick = () => { window.focus(); n.close(); };
        }
      } catch {
        // Some browsers refuse to build one outside a page action; the on-screen card is the main alert.
      }
    }
  }, [ringing.data]);

  const answer = useCallback(
    async (r: Ringing, action: 'accept' | 'decline') => {
      setBusy(r.sessionId);
      setError(null);
      try {
        await api(`/communications/${r.sessionId}/respond`, { method: 'POST', body: { action } });
        reload();
        if (action === 'accept') router.push(`/video/${r.sessionId}`);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
        reload();
      } finally {
        setBusy(null);
      }
    },
    [reload, router],
  );

  const list = ringing.data ?? [];
  if (!allowed || list.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-3" role="alert" aria-live="assertive">
      {list.map((r) => (
        <div key={r.sessionId} className="glass rounded-2xl border border-brand/30 p-4 shadow-2xl">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 animate-pulse place-items-center rounded-full bg-mint text-brand"><PhoneIncoming className="h-5 w-5" aria-hidden /></span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                {r.kind === 'voice' ? <Mic className="h-3.5 w-3.5" aria-hidden /> : <Video className="h-3.5 w-3.5" aria-hidden />}
                Incoming {r.kind === 'voice' ? 'voice' : 'video'} call
              </p>
              <p className="truncate text-sm text-ink">{r.fromName}</p>
              {(r.leadName || r.title) && <p className="truncate text-xs text-muted">{r.leadName ? `About ${r.leadName}` : r.title}</p>}
              {r.leadId && <a href={`/leads/${r.leadId}`} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand underline">Open the lead</a>}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button className="flex-1" variant="primary" onClick={() => void answer(r, 'accept')} loading={busy === r.sessionId}>Accept</Button>
            <Button className="flex-1" variant="danger" onClick={() => void answer(r, 'decline')} disabled={busy === r.sessionId}><PhoneOff className="h-4 w-4" aria-hidden /> Decline</Button>
          </div>
        </div>
      ))}
      {error && <p className="rounded-lg bg-bad-50 px-3 py-2 text-xs text-bad">{error}</p>}
    </div>
  );
}
