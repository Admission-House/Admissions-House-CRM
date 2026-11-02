import { useState } from 'react';
import { api } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { Activity, LeadDetail, LeadFollowUp, Page, StatusOption } from '@/models/types';

/** One lead: its details, follow-ups and history, and the things a counsellor does to it. */
export function useLeadViewModel(id: string) {
  const lead = useApi<LeadDetail>(`/leads/${id}`);
  const followUps = useApi<LeadFollowUp[]>(`/leads/${id}/followups`);
  const activities = useApi<Page<Activity>>(`/leads/${id}/activities`, { limit: 30 });
  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const reloadAll = () => { lead.reload(); followUps.reload(); activities.reload(); };

  async function run(name: string, work: () => Promise<void>, okText?: string): Promise<boolean> {
    setBusy(name);
    setNotice(null);
    try {
      await work();
      if (okText) setNotice({ tone: 'ok', text: okText });
      return true;
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const call = () => run('call', async () => { await api(`/leads/${id}/call`, { method: 'POST', body: {} }); }, 'Calling your phone now. Pick it up and the student will be connected.');

  const changeStatus = (input: { statusId: string; substatusId?: string; remark?: string; followUpAt?: Date }) =>
    run('status', async () => {
      await api(`/leads/${id}/status`, {
        method: 'POST',
        body: {
          statusId: input.statusId,
          ...(input.substatusId && { substatusId: input.substatusId }),
          ...(input.remark?.trim() && { remark: input.remark.trim() }),
          ...(input.followUpAt && { followUp: { dueAt: input.followUpAt.toISOString() } }),
        },
      });
      reloadAll();
    }, 'Saved.');

  const addNote = (remark: string) => run('note', async () => { await api(`/leads/${id}/notes`, { method: 'POST', body: { remark: remark.trim() } }); activities.reload(); }, 'Note added.');

  const addFollowUp = (dueAt: Date, note?: string) =>
    run('followup', async () => {
      await api(`/leads/${id}/followups`, { method: 'POST', body: { dueAt: dueAt.toISOString(), ...(note?.trim() && { note: note.trim() }) } });
      reloadAll();
    }, 'Follow-up added.');

  const doneFollowUp = (followUpId: string) => run('done', async () => { await api(`/followups/${followUpId}/done`, { method: 'POST', body: {} }); reloadAll(); });

  return { lead, followUps, activities, statuses, busy, notice, call, changeStatus, addNote, addFollowUp, doneFollowUp, reloadAll };
}
