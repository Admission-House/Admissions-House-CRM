import { useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { FormStatus, ReconciliationStatus, Shortlist, ShortlistView } from '@/models/types';

export const FORM_STATUS: { key: FormStatus; label: string }[] = [
  { key: 'not_started', label: 'Not started' }, { key: 'filled', label: 'Form filled' }, { key: 'submitted', label: 'Form submitted' },
];
export const RECON_STATUS: { key: ReconciliationStatus; label: string }[] = [
  { key: 'not_sent', label: 'Not sent' }, { key: 'mail_sent', label: 'Mail sent' }, { key: 'reconciled', label: 'Reconciled' },
];

/** One list of a lead's shortlisted colleges (active, marked NI or DNP, or reconciled) and the changes to each. */
export function useShortlistViewModel(leadId: string, view: ShortlistView, onChanged: () => void) {
  const list = useApi<Shortlist[]>(`/leads/${leadId}/shortlists`, { view });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Runs one change, then reloads. Returns whether it worked. */
  async function run(key: string, call: () => Promise<unknown>): Promise<boolean> {
    setBusy(key);
    setError(null);
    try {
      await call();
      list.reload();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const base = (id: string) => `/leads/${leadId}/shortlists/${id}`;
  return {
    list, error, busy,
    setFormStatus: (id: string, formStatus: FormStatus) => run(`form${id}`, () => api(base(id), { method: 'PATCH', body: { formStatus } })),
    setReconciliation: (id: string, reconciliationStatus: ReconciliationStatus) => run(`recon${id}`, () => api(base(id), { method: 'PATCH', body: { reconciliationStatus } })),
    markNiDnp: (id: string, kind: 'ni' | 'dnp', reason: string) => run(`nidnp${id}`, () => api(`${base(id)}/ni-dnp`, { method: 'PUT', body: { kind, reason: reason.trim() } })),
    undoNiDnp: (id: string) => run(`nidnp${id}`, () => api(`${base(id)}/ni-dnp`, { method: 'DELETE' })),
    recordPayment: (id: string, amount: number) => run(`pay${id}`, () => api(`${base(id)}/payment`, { method: 'PUT', body: { amount } })),
    clearPayment: (id: string) => run(`pay${id}`, () => api(`${base(id)}/payment`, { method: 'DELETE' })),
    remove: (id: string) => run(`rm${id}`, () => api(base(id), { method: 'DELETE' })),
  };
}
