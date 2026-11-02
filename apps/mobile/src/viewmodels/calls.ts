import { useMemo, useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { Call, Page } from '@/models/types';

export type CallFilter = 'all' | 'incoming' | 'outgoing' | 'missed' | 'pending';
export const CALL_FILTERS: { key: CallFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'incoming', label: 'Incoming' },
  { key: 'outgoing', label: 'Outgoing' },
  { key: 'missed', label: 'Missed' },
  { key: 'pending', label: 'Form pending' },
];

/** How a call outcome is shown: the words and the badge colour. */
export const OUTCOME: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' | 'info' }> = {
  connected: { label: 'Connected', tone: 'ok' }, missed: { label: 'Missed', tone: 'bad' }, not_picked: { label: 'Not picked', tone: 'warn' },
  busy: { label: 'Busy', tone: 'warn' }, failed: { label: 'Failed', tone: 'bad' }, ringing: { label: 'Ringing', tone: 'info' }, requested: { label: 'Calling', tone: 'info' },
};

export const callLength = (s: number | null) => (s ? `${Math.floor(s / 60)}m ${s % 60}s` : '—');

export function useCallsViewModel() {
  const [filter, setFilter] = useState<CallFilter>('all');
  const query = useMemo(
    () => ({
      limit: 100,
      direction: filter === 'incoming' || filter === 'outgoing' ? filter : undefined,
      outcome: filter === 'missed' ? 'missed' : undefined,
      unwrapped: filter === 'pending' ? 'true' : undefined,
    }),
    [filter],
  );
  const list = useApi<Page<Call>>('/calls', query);
  const [error, setError] = useState<string | null>(null);

  /** Rings the counsellor's own phone, then connects the student. Returns the message to show. */
  async function callBack(leadId: string): Promise<string> {
    setError(null);
    try {
      await api(`/leads/${leadId}/call`, { method: 'POST', body: {} });
      return 'Calling your phone now. Pick it up and the student will be connected.';
    } catch (e) {
      setError(errorText(e));
      return '';
    }
  }

  return { filter, setFilter, list, error, callBack };
}
