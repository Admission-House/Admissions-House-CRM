import { useMemo, useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { FollowUp, Page } from '@/models/types';

export type Bucket = 'today' | 'overdue' | 'upcoming' | 'done';
export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'done', label: 'Done' },
];

export function useFollowUpsViewModel() {
  const [bucket, setBucket] = useState<Bucket>('today');
  const query = useMemo(() => ({ limit: 100, bucket }), [bucket]);
  const list = useApi<Page<FollowUp>>('/followups', query);
  const summary = useApi<{ overdue: number; today: number; upcoming: number }>('/followups/summary');
  const [error, setError] = useState<string | null>(null);

  const refresh = () => { list.reload(); summary.reload(); };

  async function markDone(id: string) {
    setError(null);
    try {
      await api(`/followups/${id}/done`, { method: 'POST', body: {} });
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function call(leadId: string): Promise<string> {
    setError(null);
    try {
      await api(`/leads/${leadId}/call`, { method: 'POST', body: {} });
      return 'Calling your phone now. Pick it up and the student will be connected.';
    } catch (e) {
      setError(errorText(e));
      return '';
    }
  }

  return { bucket, setBucket, list, summary, error, refresh, markDone, call };
}
