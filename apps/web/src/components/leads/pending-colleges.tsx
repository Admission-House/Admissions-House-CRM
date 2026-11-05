'use client';

import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, Empty, Notice, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Pending {
  id: string;
  name: string;
  location: { id: string; name: string; state: string | null } | null;
  courseCount: number;
}

/** Institutes added by hand by counsellors. An Admin keeps one in the list or turns it down. */
export function PendingColleges() {
  const pending = useApi<Page<Pending>>('/colleges', { pendingReview: 'true', limit: 50 });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setError(null);
    setBusy(id);
    try {
      await api(`/colleges/${id}/review`, { method: 'POST', body: { decision } });
      pending.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Institutes waiting for review</h2>
        <p className="mt-0.5 text-xs text-muted">Counsellors added these by hand. Keep the ones that are right.</p>
      </div>
      {error && <div className="p-4"><Notice tone="bad">{error}</Notice></div>}
      {pending.loading && !pending.data ? <Spinner /> : (pending.data?.items.length ?? 0) === 0 ? <Empty title="Nothing to review">Institutes added by counsellors will appear here.</Empty> : (
        <ul className="divide-y divide-line">
          {pending.data!.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{c.name}</p>
                <p className="mt-0.5 flex items-center gap-3 text-xs text-muted">
                  {c.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden />{c.location.name}{c.location.state ? `, ${c.location.state}` : ''}</span>}
                  <span>{c.courseCount} course{c.courseCount === 1 ? '' : 's'}</span>
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={busy === c.id} onClick={() => void decide(c.id, 'rejected')}>Turn down</Button>
                <Button loading={busy === c.id} onClick={() => void decide(c.id, 'approved')}>Keep</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
