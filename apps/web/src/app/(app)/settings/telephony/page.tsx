'use client';

import { Check, Copy, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Field, Notice, Panel, Select, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/use-api';

interface Connection { provider: string; isEnabled: boolean; webhookKeyPrefix: string; hasCredentials: boolean; recordingHosts: string[]; providers: string[] }

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

function KeyBox({ value, onClose }: { value: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* shown on screen */ }
  }
  return (
    <div className="space-y-3">
      <Notice tone="warn">This webhook key is shown only once. Give it to your calling provider now. If it is lost, make a new one (the old one stops working at once).</Notice>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line-strong bg-head px-4 py-3">
        <code className="select-all break-all text-sm font-semibold text-ink">{value}</code>
        <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <><Check className="h-3.5 w-3.5" aria-hidden /> Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden /> Copy</>}</Button>
      </div>
      <Button variant="secondary" size="sm" onClick={onClose}>I have saved it</Button>
    </div>
  );
}

export default function TelephonyPage() {
  const conn = useApi<Connection | null>('/telephony/connection');
  const [provider, setProvider] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [hosts, setHosts] = useState<string | null>(null);
  const [config, setConfig] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);

  if (conn.error) return <Notice tone="bad">{conn.error.message}</Notice>;
  if (conn.data === undefined) return <Spinner />;
  const c = conn.data;
  const providers = c?.providers ?? [];
  const chosen = provider || c?.provider || providers[0] || 'generic';
  const isOn = enabled ?? c?.isEnabled ?? true;
  const hostText = hosts ?? (c?.recordingHosts ?? []).join('\n');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    let parsed: Record<string, unknown> | undefined;
    if (config.trim()) {
      try {
        parsed = JSON.parse(config) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      } catch {
        return setMsg({ tone: 'bad', text: 'The provider settings must be a JSON object.' });
      }
    }
    setBusy(true);
    try {
      const r = await api<{ webhookKey?: string }>('/telephony/connection', { method: 'PUT', body: { provider: chosen, isEnabled: isOn, recordingHosts: hostText.split(/\s+/).filter(Boolean), ...(parsed && { config: parsed }) } });
      if (r.webhookKey) setKey(r.webhookKey);
      setConfig('');
      setHosts(null);
      conn.reload();
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setMsg(null);
    try {
      const r = await api<{ webhookKey: string }>('/telephony/connection/rotate-key', { method: 'POST', body: {} });
      setKey(r.webhookKey);
      conn.reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    }
  }

  return (
    <div className="space-y-6">
      <Panel title="Calling provider">
        <form onSubmit={save} className="max-w-2xl space-y-4">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          {!c && <Notice tone="info">No calling provider is connected yet. Save this form to connect one. Calls and missed-call leads start working as soon as it is on.</Notice>}
          <Field label="Provider" htmlFor="tp">
            <Select id="tp" value={chosen} onChange={(e) => setProvider(e.target.value)}>{(providers.length ? providers : ['generic']).map((p) => <option key={p} value={p}>{p}</option>)}</Select>
          </Field>
          <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={isOn} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> Calling is on</label>
          <Field label="Provider settings and credentials" htmlFor="tc" hint={c?.hasCredentials ? 'Credentials are saved and hidden. Paste new JSON only to replace them.' : 'JSON given by your provider. It is stored encrypted and never shown again.'}>
            <Textarea id="tc" value={config} onChange={(e) => setConfig(e.target.value)} placeholder={c?.hasCredentials ? 'Leave empty to keep what is saved' : 'Paste the JSON your provider gave you'} className="min-h-28 font-mono text-xs" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Recording hosts" htmlFor="th" hint="One per line. Recordings are downloaded only from these hosts, for example recordings.provider.com.">
            <Textarea id="th" value={hostText} onChange={(e) => setHosts(e.target.value)} className="min-h-20 font-mono text-xs" spellCheck={false} />
          </Field>
          <Button type="submit" loading={busy}>Save</Button>
        </form>
      </Panel>

      {c && (
        <Panel title="Webhook key">
          <div className="max-w-2xl space-y-3">
            <p className="text-sm text-muted">Your provider sends call events to <code>/api/v1/telephony/webhook</code> on your API address, with this key in the <code>Authorization: Bearer</code> or <code>X-Webhook-Key</code> header.</p>
            <p className="flex items-center gap-2 text-sm">Current key starts with <Badge>{c.webhookKeyPrefix}…</Badge></p>
            {key ? <KeyBox value={key} onClose={() => setKey(null)} /> : <Button variant="secondary" onClick={() => void rotate()}><RotateCw className="h-3.5 w-3.5" aria-hidden /> Make a new key</Button>}
          </div>
        </Panel>
      )}
    </div>
  );
}
