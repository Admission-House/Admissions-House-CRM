import { useState } from 'react';
import { api, ApiError } from '@/core/api';
import { useApi } from '@/core/use-api';
import type { Profile } from '@/models/types';

export const LEVELS = [
  { key: '10th', label: '10th' }, { key: '12th', label: '12th' }, { key: 'diploma', label: 'Diploma' },
  { key: 'graduation', label: 'Graduation' }, { key: 'post_graduation', label: 'Post graduation' },
] as const;
export const RELATIONS = [{ key: 'father', label: 'Father' }, { key: 'mother', label: 'Mother' }, { key: 'guardian', label: 'Guardian' }] as const;

/** An empty box is "nothing", not an empty string. */
export const str = (v: string): string | null => (v.trim() === '' ? null : v.trim());
export const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
export const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The Profile tab of one lead: load it, save changes, and say what went wrong in plain words. */
export function useProfileViewModel(leadId: string) {
  const profile = useApi<Profile>(`/leads/${leadId}/profile`);
  const streams = useApi<{ id: string; name: string }[]>('/streams');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(body: object): Promise<boolean> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/leads/${leadId}/profile`, { method: 'PATCH', body });
      setSaved(true);
      profile.reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Something went wrong. Try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { profile, streams, busy, error, saved, save };
}
