'use client';

import { Trophy, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import type { Notification } from './notifications';

/** A win older than this is old news: it stays in the bell, but no card pops up for it. */
const FRESH_MS = 15 * 60_000;
/** How long a card stays before it slides away by itself (it stays unread in the bell). */
const SHOW_MS = 15_000;

const SEEN_KEY = 'ah_wins_seen';
function readSeen(): string[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeSeen(ids: string[]) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Private windows may refuse storage; the card may then show once more after a reload, which is harmless.
  }
}

/**
 * When a counsellor wins a lead (moves it to a status the company counts as won), everyone gets a small card on
 * whatever screen they are on, for motivation. The person who won it reads it as their own win. Closing the card marks
 * that notification as read; letting it slide away leaves it unread in the bell.
 */
export function WinCelebration() {
  const { me } = useAuth();
  const wins = useApi<Page<Notification>>('/notifications', { limit: 10, unreadOnly: 'true' });
  useRealtime(['notification'], wins.reload, 1_000);
  // Cards already seen in this browser tab are not shown again after a reload (they stay in the bell).
  const [gone, setGone] = useState<Set<string>>(() => new Set(readSeen()));
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const current = useMemo(
    () => (wins.data?.items ?? []).find((n) => n.payload.event === 'lead_won' && !gone.has(n.id) && now - new Date(n.createdAt).getTime() < FRESH_MS) ?? null,
    [wins.data, gone, now],
  );

  // The clock that ages the cards, and the timer that hides the one on screen.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!current) return;
    writeSeen([...readSeen().filter((id) => id !== current.id), current.id]);
    timer.current = setTimeout(() => setGone((g) => new Set(g).add(current.id)), SHOW_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [current]);

  if (!current || !me) return null;
  const p = current.payload;
  const mine = p.winnerId === me.user.id;
  const winner = typeof p.winnerName === 'string' ? p.winnerName : 'A counsellor';
  const first = winner.split(/\s+/)[0];

  async function close() {
    if (!current) return;
    setGone((g) => new Set(g).add(current.id));
    await api('/notifications/read', { method: 'POST', body: { ids: [current.id] } }).catch(() => undefined);
  }

  return (
    <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-warn/40 bg-surface shadow-2xl">
      <div className="h-1 bg-gradient-to-r from-warn via-teal to-brand" aria-hidden />
      <div className="flex gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-warn/15 text-warn"><Trophy className="h-6 w-6" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{mine ? 'You won an admission!' : `${winner} won an admission`}</p>
          <p className="mt-0.5 text-sm text-muted">
            Lead {String(p.leadNo ?? '')} moved to {typeof p.status === 'string' ? p.status : 'won'}. {mine ? 'Great work, keep it going.' : `Well done, ${first}!`}
          </p>
        </div>
        <button type="button" onClick={() => void close()} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-subtle hover:bg-head hover:text-ink"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
