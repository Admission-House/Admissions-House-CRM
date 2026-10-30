'use client';

import { Smartphone } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Notice, Panel, Select, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import type { Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface Device {
  id: string;
  user: { id: string; name: string };
  platform: string;
  label: string | null;
  fingerprintTail: string;
  status: 'pending' | 'approved';
  approvedBy: string | null;
  approvedAt: string | null;
  firstSeenAt: string;
}

export default function DevicesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<'pending' | 'approved' | 'all'>('pending');
  const list = useApi<Page<Device>>('/devices', useMemo(() => ({ status, limit: 100 }), [status]));
  const [error, setError] = useState<string | null>(null);

  async function act(d: Device, action: 'approve' | 'revoke') {
    setError(null);
    try {
      await api(`/devices/${d.id}/${action}`, { method: 'POST', body: {} });
      list.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
    }
  }

  return (
    <Panel title="Mobile devices" flush actions={<Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-60"><option value="pending">Waiting for approval</option><option value="approved">Approved</option><option value="all">All</option></Select>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">Each person signs in on the mobile app only from a phone you have approved.</p>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : !list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty title={status === 'pending' ? 'No phone is waiting' : 'No devices'}>Phones appear here when someone signs in from a new one.</Empty> : (
        <ul className="divide-y divide-line">
          {list.data.items.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-head text-brand"><Smartphone className="h-5 w-5" aria-hidden /></span>
                <div>
                  <p className="flex items-center gap-2 text-[15px] font-semibold">{d.user.name}<Badge tone={d.status === 'approved' ? 'ok' : 'warn'}>{d.status === 'approved' ? 'Approved' : 'Waiting'}</Badge></p>
                  <p className="text-xs text-muted">{d.label ?? d.platform} · ends …{d.fingerprintTail} · first seen {fmtDateTime(d.firstSeenAt)}{d.approvedBy ? ` · approved by ${d.approvedBy}` : ''}</p>
                </div>
              </div>
              {can('device.approve') && (d.status === 'pending' ? <Button size="sm" onClick={() => void act(d, 'approve')}>Approve</Button> : <Button size="sm" variant="danger" onClick={() => void act(d, 'revoke')}>Remove</Button>)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
