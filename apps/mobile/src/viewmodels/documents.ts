import { useState } from 'react';
import { api } from '@/core/api';
import type { PickedFile } from '@/core/pick-file';
import { shareFile } from '@/core/share-file';
import { errorText, useApi } from '@/core/use-api';
import type { DocumentLimits, LeadDocument, Shortlist } from '@/models/types';

export const BASIC_DOCUMENTS = [
  { type: 'aadhaar', label: 'Aadhaar card' }, { type: 'tenth', label: '10th certificate' }, { type: 'twelfth', label: '12th certificate' },
  { type: 'graduation', label: 'Graduation sheet' }, { type: 'photo', label: 'Passport photo' }, { type: 'signature', label: 'Student signature' },
  { type: 'other', label: 'Other documents' },
] as const;

export const fileSize = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The Documents tab of one lead: what is uploaded for each kind of document, uploading, opening and removing. */
export function useDocumentsViewModel(leadId: string) {
  const docs = useApi<LeadDocument[]>(`/leads/${leadId}/documents`);
  const limits = useApi<DocumentLimits>('/documents/limits');
  const shortlists = useApi<Shortlist[]>(`/leads/${leadId}/shortlists`, { view: 'active' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const all = docs.data ?? [];
  const of = (type: string, shortlistId?: string) => all.filter((d) => d.docType === type && (d.shortlist?.id ?? undefined) === shortlistId);

  async function run(key: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : errorText(e));
    } finally {
      setBusy(null);
    }
  }

  /** Sends a chosen file. A file over the limit is refused here, with its size, rather than after a long upload. */
  const upload = (key: string, docType: string, file: PickedFile, shortlistId?: string) =>
    run(key, async () => {
      const max = limits.data?.maxBytes;
      if (max && file.size && file.size > max) {
        throw new Error(`${file.name} is ${fileSize(file.size)}, more than the ${fileSize(max)} allowed. Choose a smaller file or take the photo again.`);
      }
      const form = new FormData();
      form.append('docType', docType);
      if (shortlistId) form.append('shortlistId', shortlistId);
      // React Native's form data takes a file as { uri, name, type }.
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      await api(`/leads/${leadId}/documents`, { method: 'POST', form });
      docs.reload();
    });

  const remove = (d: LeadDocument) => run(`rm${d.id}`, async () => { await api(`/leads/${leadId}/documents/${d.id}`, { method: 'DELETE' }); docs.reload(); });
  const open = (d: LeadDocument) => run(`open${d.id}`, () => shareFile(`/leads/${leadId}/documents/${d.id}/file`, d.name, d.mimeType, d.name));

  return { docs, limits, shortlists, error, busy, of, upload, remove, open, setError };
}
