'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

const EVERY_MS = 60_000;

/**
 * A bar at the top when the CRM was updated after this tab was opened. The page keeps the screens it loaded until it is
 * reloaded, so without this an open tab shows the old version after a deployment.
 */
export function NewVersionNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let first: string | null = null;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch('/app-version', { cache: 'no-store' });
        if (!res.ok) return;
        const { id } = (await res.json()) as { id?: string };
        if (!id || stopped) return;
        if (first === null) first = id;
        else if (id !== first) setStale(true);
      } catch {
        // offline for a moment: try again next time
      }
    };
    void check();
    const timer = setInterval(() => void check(), EVERY_MS);
    const back = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[90] flex flex-wrap items-center justify-center gap-3 bg-brand px-4 py-2 text-sm text-white shadow-lg"
    >
      <span>The CRM has been updated. Reload to get the latest version.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1 font-semibold text-brand hover:bg-mint"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reload
      </button>
    </div>
  );
}
