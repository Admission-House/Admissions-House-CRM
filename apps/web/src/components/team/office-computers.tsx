'use client';

import { Monitor } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Empty, Notice, Panel, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime, fromNow } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Computer {
  id: string;
  user: { id: string; name: string };
  state: 'pending' | 'approved';
  label: string | null;
  lastIp: string | null;
  registeredBy: 'office_network' | 'approval' | null;
  decidedBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * The computers people sign in from at the office. A computer that signs in from an address on the office list is registered by
 * itself. One that is at the office on some other address (the internet provider changes it) waits here for approval, once.
 * After that the person's position is the proof, whatever address the provider gives that day.
 */
export function OfficeComputers() {
  const { can } = useAuth();
  const [state, setState] = useState<'pending' | 'approved'>('pending');
  const list = useApi<Computer[]>('/office-computers', { state });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(c: Computer, action: 'approve' | 'reject' | 'remove') {
    setBusy(c.id);
    setError(null);
    try {
      if (action === 'remove') await api(`/office-computers/${c.id}`, { method: 'DELETE' });
      else await api(`/office-computers/${c.id}/${action}`, { method: 'POST', body: {} });
      list.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Office computers"
      flush
      actions={<Select aria-label="Show" value={state} onChange={(e) => setState(e.target.value as typeof state)} className="w-60"><option value="pending">Waiting for approval</option><option value="approved">Registered</option></Select>}
    >
      <p className="border-b border-line px-4 py-3 text-xs text-muted">
        A computer that signs in from an office address is registered by itself. One that is at the office on another address waits here until you approve it. After that, the person can sign in from it every day whatever address the internet provider gives; their position at the office is still checked each time.
      </p>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.error ? (
        <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div>
      ) : !list.data ? (
        <Spinner />
      ) : list.data.length === 0 ? (
        <Empty title={state === 'pending' ? 'No computer is waiting' : 'No computer is registered yet'} />
      ) : (
        <ul className="divide-y divide-line">
          {list.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-head text-brand"><Monitor className="h-5 w-5" aria-hidden /></span>
                <div>
                  <p className="flex items-center gap-2 text-[15px] font-semibold">{c.user.name}<Badge tone={c.state === 'approved' ? 'ok' : 'warn'}>{c.state === 'approved' ? 'Registered' : 'Waiting'}</Badge></p>
                  <p className="text-xs text-muted">
                    {c.label ?? 'A computer'}{c.lastIp ? ` · from ${c.lastIp}` : ''} · {c.state === 'pending' ? `asked ${fmtDateTime(c.createdAt)}` : c.lastUsedAt ? `last used ${fromNow(c.lastUsedAt)}` : 'not used yet'}
                    {c.state === 'approved' ? (c.registeredBy === 'approval' ? ` · approved${c.decidedBy ? ` by ${c.decidedBy}` : ''}` : ' · registered from an office address') : ''}
                  </p>
                </div>
              </div>
              {can('device.approve') && (
                <div className="flex gap-2">
                  {c.state === 'pending' && <Button size="sm" loading={busy === c.id} onClick={() => void act(c, 'approve')}>Approve</Button>}
                  {c.state === 'pending' && <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => void act(c, 'reject')}>Turn down</Button>}
                  {c.state === 'approved' && <Button size="sm" variant="danger" loading={busy === c.id} onClick={() => void act(c, 'remove')}>Remove</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
