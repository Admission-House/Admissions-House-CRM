import { useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { Call, Page, StatusOption } from '@/models/types';

export interface WrapUpInput { statusId: string; substatusId?: string; remark?: string; followUpAt?: Date }

/** The body the API wants for the after-call form. */
export function wrapUpBody(input: WrapUpInput) {
  return {
    statusId: input.statusId,
    ...(input.substatusId && { substatusId: input.substatusId }),
    ...(input.remark?.trim() && { remark: input.remark.trim() }),
    ...(input.followUpAt && { followUp: { dueAt: input.followUpAt.toISOString() } }),
  };
}

/** The Calls tab of one lead: its calls, and the after-call form for a call that has none yet. */
export function useLeadCallsViewModel(leadId: string, onChanged: () => void) {
  const list = useApi<Page<Call>>(`/leads/${leadId}/calls`, { limit: 50 });
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [wrapping, setWrapping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function wrapUp(input: WrapUpInput): Promise<boolean> {
    if (!wrapping) return false;
    setBusy(true);
    setError(null);
    try {
      await api(`/calls/${wrapping}/wrap-up`, { method: 'POST', body: wrapUpBody(input) });
      setWrapping(null);
      list.reload();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { list, statuses, wrapping, startWrapUp: setWrapping, closeWrapUp: () => { setWrapping(null); setError(null); }, busy, error, wrapUp };
}
