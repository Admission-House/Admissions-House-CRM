'use client';

import { Check, Copy, KeyRound, Plus, RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select, Spinner, Tabs } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime, fromNow } from '@/lib/format';
import type { Page, SourceOption } from '@/lib/types';
import { useApi } from '@/lib/use-api';

interface ApiKey { id: string; name: string; source: { id: string; name: string }; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface EventRow { id: string; source: string | null; externalId: string; status: string; attempts: number; error: string | null; receivedAt: string; processedAt: string | null }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');
const EVENT_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'neutral'> = { processed: 'ok', failed: 'bad', received: 'warn', ignored: 'neutral' };
const EVENT_LABEL: Record<string, string> = { processed: 'Done', failed: 'Failed', received: 'Waiting', ignored: 'Ignored' };

/** The key is shown once. After this window it can never be looked up again. */
function ShowOnce({ title, name, secret, hint, onClose }: { title: string; name: string; secret: string; hint: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the key is on screen to copy by hand */ }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <Notice tone="warn">This key is shown only once. Put it in {name} now. If it is lost, make a new one.</Notice>
      <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-line-strong bg-head px-4 py-3">
        <code className="select-all break-all text-sm font-semibold text-ink">{secret}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <><Check className="h-3.5 w-3.5" aria-hidden /> Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden /> Copy</>}</Button>
      </div>
      <p className="mt-3 text-xs text-muted">{hint}</p>
      <div className="mt-5 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

function Keys() {
  const keys = useApi<ApiKey[]>('/integrations/api-keys');
  const sources = useApi<SourceOption[]>('/lead-sources');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ name: string; key: string }>('/integrations/api-keys', { method: 'POST', body: { name: name.trim(), sourceId } });
      setSecret({ name: r.name, key: r.key });
      setAdding(false);
      setName('');
      setSourceId('');
      keys.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(k: ApiKey) {
    setError(null);
    try { await api(`/integrations/api-keys/${k.id}`, { method: 'DELETE' }); keys.reload(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <Panel title="API keys" flush actions={<Button onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" aria-hidden /> New key</Button>}>
      <p className="border-b border-line px-4 py-3 text-xs text-muted">A key lets a website, ad form or portal send leads to this CRM. Every lead from a key gets the source you pick. Send the key in the <code>Authorization: Bearer</code> header to <code>/api/v1/intake/leads</code>.</p>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {keys.error ? <div className="p-4"><Notice tone="bad">{keys.error.message}</Notice></div> : !keys.data ? <Spinner /> : keys.data.length === 0 ? <Empty title="No keys yet">Make one for your website, then paste it into the settings of your website.</Empty> : (
        <ul className="divide-y divide-line">
          {keys.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-head text-brand"><KeyRound className="h-5 w-5" aria-hidden /></span>
                <div>
                  <p className="flex items-center gap-2 text-[15px] font-semibold">{k.name}{k.revokedAt && <Badge tone="bad">Revoked</Badge>}</p>
                  <p className="text-xs text-muted">Source {k.source.name} · starts {k.prefix}… · {k.lastUsedAt ? `last used ${fromNow(k.lastUsedAt)}` : 'never used'} · made {fmtDateTime(k.createdAt)}</p>
                </div>
              </div>
              {!k.revokedAt && <Button size="sm" variant="danger" onClick={() => void revoke(k)}>Revoke</Button>}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <Modal title="New API key" onClose={() => setAdding(false)}>
          <form onSubmit={create} className="space-y-4">
            {error && <Notice tone="bad">{error}</Notice>}
            <Field label="Name" htmlFor="kn" required hint="Where it will be used, for example Website"><Input id="kn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
            <Field label="Source of its leads" htmlFor="ks" required><Select id="ks" value={sourceId} onChange={(e) => setSourceId(e.target.value)} required><option value="">Choose a source</option>{sources.data?.filter((s) => s.isActive !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" loading={busy}>Make key</Button></div>
          </form>
        </Modal>
      )}
      {secret && <ShowOnce title="Your new key" name={secret.name} secret={secret.key} hint="Keep it out of chat and email. Anyone with this key can add leads." onClose={() => setSecret(null)} />}
    </Panel>
  );
}

function Events() {
  const [status, setStatus] = useState('');
  const list = useApi<Page<EventRow>>('/integrations/events', useMemo(() => ({ limit: 50, status: status || undefined }), [status]));
  const [error, setError] = useState<string | null>(null);
  async function retry(e: EventRow) {
    setError(null);
    try { await api(`/integrations/events/${e.id}/retry`, { method: 'POST', body: {} }); list.reload(); } catch (err) { setError(errorText(err)); }
  }
  return (
    <Panel title="Leads received" flush actions={<Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-48"><option value="">Every status</option>{Object.entries(EVENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}>
      {error && <div className="p-3 pb-0"><Notice tone="bad">{error}</Notice></div>}
      {list.error ? <div className="p-4"><Notice tone="bad">{list.error.message}</Notice></div> : !list.data ? <Spinner /> : list.data.items.length === 0 ? <Empty title="Nothing received yet">Leads sent by your website or forms are listed here.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-head text-xs uppercase tracking-wide text-muted"><tr><th className="px-4 py-2.5 font-semibold">Received</th><th className="px-3 py-2.5 font-semibold">Source</th><th className="px-3 py-2.5 font-semibold">Reference</th><th className="px-3 py-2.5 font-semibold">Status</th><th className="px-3 py-2.5 font-semibold">Tries</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-line">
              {list.data.items.map((e) => (
                <tr key={e.id} className="hover:bg-mint-50">
                  <td className="whitespace-nowrap px-4 py-3">{fmtDateTime(e.receivedAt)}</td>
                  <td className="px-3 py-3">{e.source ?? '—'}</td>
                  <td className="tabular max-w-48 truncate px-3 py-3 text-muted" title={e.externalId}>{e.externalId}</td>
                  <td className="px-3 py-3"><Badge tone={EVENT_TONE[e.status] ?? 'neutral'}>{EVENT_LABEL[e.status] ?? e.status}</Badge>{e.error && <span className="block max-w-72 truncate text-xs text-bad" title={e.error}>{e.error}</span>}</td>
                  <td className="tabular px-3 py-3">{e.attempts}</td>
                  <td className="px-4 py-3 text-right">{e.status === 'failed' && <Button size="sm" variant="secondary" onClick={() => void retry(e)}><RotateCw className="h-3.5 w-3.5" aria-hidden /> Try again</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function IntegrationsPage() {
  const [tab, setTab] = useState<'keys' | 'events'>('keys');
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={[{ key: 'keys' as const, label: 'API keys' }, { key: 'events' as const, label: 'Leads received' }]} value={tab} onChange={setTab} label="Integrations" /></div>
      {tab === 'keys' ? <Keys /> : <Events />}
    </div>
  );
}
