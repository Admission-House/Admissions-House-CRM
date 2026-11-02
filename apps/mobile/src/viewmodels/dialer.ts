import { useMemo, useState } from 'react';
import { api, ApiError } from '@/core/api';
import { errorText, useApi } from '@/core/use-api';
import type { DialerSession, LeadListItem, Page, Queues, StatusOption } from '@/models/types';
import { wrapUpBody, type WrapUpInput } from './lead-calls';

export const DIAL_QUEUES: { key: string; label: string }[] = [
  { key: 'fresh', label: 'Fresh' },
  { key: 'missed', label: 'Missed' },
  { key: 'followup', label: 'Follow-up' },
  { key: 'counselled', label: 'Counselled' },
  { key: 'fee_paid', label: 'Fee paid' },
];

export type DialerAction = 'dial' | 'skip' | 'pause' | 'resume' | 'stop';
type Notice = { tone: 'ok' | 'bad'; text: string };

/**
 * The auto dialer. Without a session it offers the person's own open leads of one queue to start from.
 * With a session it steps through it: call the next lead, skip, pause, stop. After a connected call the
 * next call is refused until the after-call form is filled in; this holds the call that is waiting.
 */
export function useDialerViewModel() {
  const session = useApi<DialerSession | null>('/dialer/sessions/current');
  const hasSession = session.data !== undefined && session.data !== null;
  const waitingForSession = session.data === undefined && !session.error;

  const [queue, setQueue] = useState('fresh');
  const queues = useApi<Queues>(hasSession || waitingForSession ? null : '/leads/queues');
  const listQuery = useMemo(() => ({ queue, assignedTo: 'me', limit: 100, sort: 'newest' }), [queue]);
  const leads = useApi<Page<LeadListItem>>(hasSession || waitingForSession ? null : '/leads', listQuery);
  const [unpicked, setUnpicked] = useState<Record<string, boolean>>({});

  const statuses = useApi<StatusOption[]>('/lead-statuses');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [wrapCallId, setWrapCallId] = useState<string | null>(null);

  const dialable = (leads.data?.items ?? []).filter((l) => l.status.isOpen);
  const chosen = dialable.filter((l) => !unpicked[l.id]);

  const changeQueue = (q: string) => { setQueue(q); setUnpicked({}); };
  const toggle = (id: string) => setUnpicked((p) => ({ ...p, [id]: !p[id] }));
  const refresh = () => { session.reload(); leads.reload(); queues.reload(); };

  async function start() {
    setBusy('start');
    setNotice(null);
    try {
      await api('/dialer/sessions', { method: 'POST', body: { leadIds: chosen.map((l) => l.id) } });
      session.reload();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function act(name: DialerAction) {
    if (!session.data) return;
    setBusy(name);
    setNotice(null);
    try {
      await api(`/dialer/sessions/${session.data.id}/${name}`, { method: 'POST', body: {} });
      if (name === 'dial') setNotice({ tone: 'ok', text: 'Calling your phone now. Pick it up and the student will be connected. When the call ends, fill in the after-call form.' });
      session.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WRAP_UP_REQUIRED' && typeof e.details?.callId === 'string') {
        setWrapCallId(e.details.callId);
        setNotice({ tone: 'bad', text: e.message });
      } else {
        setNotice({ tone: 'bad', text: errorText(e) });
      }
    } finally {
      setBusy(null);
    }
  }

  /** Saves the after-call form for the call that is waiting. Returns whether it worked. */
  async function wrapUp(input: WrapUpInput): Promise<boolean> {
    if (!wrapCallId) return false;
    setBusy('wrap');
    try {
      await api(`/calls/${wrapCallId}/wrap-up`, {
        method: 'POST',
        body: wrapUpBody(input),
      });
      setWrapCallId(null);
      setNotice({ tone: 'ok', text: 'Saved. You can call the next lead.' });
      session.reload();
      return true;
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    session, hasSession, loadingSession: waitingForSession,
    queue, changeQueue, queues, leads, dialable, chosen, unpicked, toggle,
    statuses, busy, notice, wrapCallId, closeWrap: () => setWrapCallId(null),
    start, act, wrapUp, refresh,
  };
}
