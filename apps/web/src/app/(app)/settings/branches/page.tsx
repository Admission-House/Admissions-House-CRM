'use client';

import { Crosshair, MapPin, Plus, Trash2, Wifi, Globe } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Empty, Field, Input, Notice, Panel, Select, Spinner } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Branch {
  id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusM: number;
  detectedAt: string | null;
  isActive: boolean;
  userCount: number;
  networks: { id: string; kind: 'ip_range' | 'wifi'; ipRange: string | null; wifiId: string | null }[];
}

interface Detection {
  observedIp: string;
  suggestedRange: string | null;
  position: { lat: number; lng: number; accuracy: number };
  canSave: boolean;
  movedFromCurrentM: number | null;
  warnings: string[];
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

function readPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot read its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => reject(new Error('Location is turned off or was refused. Allow it for this site and try again.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

/** Stand in the office, press Detect: the browser reports where it is, the server says which address it sees, and the admin confirms both. */
function DetectModal({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: () => void }) {
  const [step, setStep] = useState<'ready' | 'reading' | 'review'>('ready');
  const [result, setResult] = useState<Detection | null>(null);
  const [addIp, setAddIp] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function detect() {
    setStep('reading');
    setError(null);
    try {
      const reading = await readPosition();
      setResult(await api<Detection>(`/branches/${branch.id}/detect`, { method: 'POST', body: reading }));
      setStep('review');
    } catch (e) {
      setError(errorText(e) === 'Cannot reach the server. Try again.' && e instanceof Error ? e.message : errorText(e));
      setStep('ready');
    }
  }

  async function confirm() {
    if (!result) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/branches/${branch.id}/detect/confirm`, { method: 'POST', body: { ...result.position, addCurrentIp: addIp && !!result.suggestedRange, allowInternalAddress: false } });
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const map = result ? `https://www.openstreetmap.org/?mlat=${result.position.lat}&mlon=${result.position.lng}#map=18/${result.position.lat}/${result.position.lng}` : '';
  return (
    <Modal title={`Detect the office position: ${branch.name}`} onClose={onClose}>
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {step !== 'review' ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">Do this while you are standing inside the office, on the office network. Your browser will ask to share your location. The position and the network address become the rule for the office sign-in check.</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={step === 'reading'} onClick={() => void detect()}><Crosshair className="h-3.5 w-3.5" aria-hidden /> Detect now</Button></div>
        </div>
      ) : result && (
        <div className="space-y-4">
          {result.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          <dl className="divide-y divide-line rounded-lg border border-line text-sm">
            <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted">Position</dt><dd className="tabular font-medium">{result.position.lat.toFixed(6)}, {result.position.lng.toFixed(6)}</dd></div>
            <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted">Accuracy</dt><dd className="font-medium">within {Math.round(result.position.accuracy)} m</dd></div>
            <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted">Network address seen</dt><dd className="font-medium">{result.observedIp}</dd></div>
            {result.movedFromCurrentM !== null && <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-muted">Moved from the saved position</dt><dd className="font-medium">{result.movedFromCurrentM} m</dd></div>}
          </dl>
          <a href={map} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"><MapPin className="h-3.5 w-3.5" aria-hidden /> Check this spot on the map</a>
          {result.suggestedRange && (
            <label className="flex items-start gap-2.5 text-sm"><input type="checkbox" checked={addIp} onChange={(e) => setAddIp(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#0f625e]" /><span>Also allow the network <span className="font-semibold">{result.suggestedRange}</span> for sign-in</span></label>
          )}
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setStep('ready')}>Try again</Button><Button disabled={!result.canSave} loading={busy} onClick={() => void confirm()}>Confirm and save</Button></div>
        </div>
      )}
    </Modal>
  );
}

function NetworkForm({ branch, onClose, onSaved }: { branch: Branch; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'ip_range' | 'wifi'>('ip_range');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/branches/${branch.id}/networks`, { method: 'POST', body: kind === 'ip_range' ? { kind, ipRange: value.trim() } : { kind, wifiId: value.trim() } });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return (
    <Modal title="Allow a network" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error}</Notice>}
        <Field label="Kind" htmlFor="nk"><Select id="nk" value={kind} onChange={(e) => { setKind(e.target.value as 'ip_range' | 'wifi'); setValue(''); }}><option value="ip_range">Internet address (IP or range)</option><option value="wifi">WiFi name (mobile app)</option></Select></Field>
        <Field label={kind === 'ip_range' ? 'Address or range' : 'WiFi identifier'} htmlFor="nv" hint={kind === 'ip_range' ? 'A single address such as 203.0.113.5, or a range such as 203.0.113.0/28' : 'As the phone reports it'} required>
          <Input id="nv" value={value} onChange={(e) => setValue(e.target.value)} required />
        </Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Allow</Button></div>
      </form>
    </Modal>
  );
}

function BranchForm({ branch, onClose, onSaved }: { branch?: Branch; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(branch?.name ?? '');
  const [address, setAddress] = useState(branch?.address ?? '');
  const [radius, setRadius] = useState(String(branch?.radiusM ?? 200));
  const [active, setActive] = useState(branch?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (branch) await api(`/branches/${branch.id}`, { method: 'PATCH', body: { name: name.trim(), address: address.trim() || null, radiusM: Number(radius), isActive: active } });
      else await api('/branches', { method: 'POST', body: { name: name.trim(), ...(address.trim() && { address: address.trim() }), radiusM: Number(radius) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server.'));
      setBusy(false);
    }
  }
  return (
    <Modal title={branch ? `Edit ${branch.name}` : 'Add an office'} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <Field label="Name" htmlFor="bn" required error={fe('name')}><Input id="bn" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Address" htmlFor="ba" error={fe('address')}><Input id="ba" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <Field label="Allowed distance from the office (metres)" htmlFor="br" hint="Sign-in works only within this distance of the detected position. 20 to 5000." error={fe('radiusM')}><Input id="br" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} required /></Field>
        {branch && <label className="flex items-center gap-2.5 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[#0f625e]" /> This office is in use</label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{branch ? 'Save' : 'Add office'}</Button></div>
      </form>
    </Modal>
  );
}

export default function BranchesPage() {
  const { can } = useAuth();
  const manage = can('branch.manage');
  const branches = useApi<Branch[]>('/branches');
  const [form, setForm] = useState<Branch | 'new' | null>(null);
  const [detecting, setDetecting] = useState<Branch | null>(null);
  const [adding, setAdding] = useState<Branch | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function removeNetwork(b: Branch, networkId: string) {
    setNotice(null);
    try {
      await api(`/branches/${b.id}/networks/${networkId}`, { method: 'DELETE' });
      branches.reload();
    } catch (e) {
      setNotice({ tone: 'bad', text: errorText(e) });
    }
  }

  return (
    <>
      <Panel title="Branches and office sign-in" flush actions={manage && <Button onClick={() => setForm('new')}><Plus className="h-3.5 w-3.5" aria-hidden /> Add office</Button>}>
        <p className="border-b border-line px-4 py-3 text-xs text-muted">People in office roles can sign in only from the office: on an allowed network <span className="font-semibold">and</span> within the allowed distance of the office position.</p>
        {notice && <div className="p-3 pb-0"><Notice tone={notice.tone}>{notice.text}</Notice></div>}
        {branches.error ? <div className="p-4"><Notice tone="bad">{branches.error.message}</Notice></div> : branches.loading && !branches.data ? <Spinner /> : (branches.data?.length ?? 0) === 0 ? <Empty title="No office yet">Add your office, then detect its position while standing inside it.</Empty> : (
          <ul className="divide-y divide-line">
            {branches.data!.map((b) => (
              <li key={b.id} className="space-y-3 px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 text-[15px] font-semibold">{b.name}{!b.isActive && <Badge>Not in use</Badge>}</p>
                    {b.address && <p className="mt-0.5 text-xs text-muted">{b.address}</p>}
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span>{b.userCount} active {b.userCount === 1 ? 'person' : 'people'}</span>
                      <span>Allowed distance {b.radiusM} m</span>
                      {b.latitude !== null ? <span className="inline-flex items-center gap-1 text-ok"><MapPin className="h-3 w-3" aria-hidden /> Position set{b.detectedAt ? ` ${fmtDateTime(b.detectedAt)}` : ''}</span> : <span className="font-medium text-warn">Position not set yet</span>}
                    </p>
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="accent" onClick={() => setDetecting(b)}><Crosshair className="h-3.5 w-3.5" aria-hidden /> Detect position</Button>
                      <Button size="sm" variant="secondary" onClick={() => setForm(b)}>Edit</Button>
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-line">
                  <div className="flex items-center justify-between bg-head px-3 py-2"><p className="text-xs font-semibold uppercase tracking-wide text-muted">Allowed networks</p>{manage && <button onClick={() => setAdding(b)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"><Plus className="h-3 w-3" aria-hidden /> Add</button>}</div>
                  {b.networks.length === 0 ? <p className="px-3 py-3 text-xs text-warn">No network is allowed yet, so office sign-in will be refused. Detect the position, or add a network.</p> : (
                    <ul className="divide-y divide-line">
                      {b.networks.map((n) => (
                        <li key={n.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                          <span className="inline-flex items-center gap-2">{n.kind === 'ip_range' ? <Globe className="h-3.5 w-3.5 text-muted" aria-hidden /> : <Wifi className="h-3.5 w-3.5 text-muted" aria-hidden />}<span className="tabular font-medium">{n.ipRange ?? n.wifiId}</span><Badge>{n.kind === 'ip_range' ? 'Internet address' : 'WiFi'}</Badge></span>
                          {manage && <button onClick={() => void removeNetwork(b, n.id)} aria-label={`Remove ${n.ipRange ?? n.wifiId}`} className="text-bad hover:opacity-70"><Trash2 className="h-3.5 w-3.5" /></button>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {form && <BranchForm branch={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); branches.reload(); }} />}
      {detecting && <DetectModal branch={detecting} onClose={() => setDetecting(null)} onSaved={() => { setDetecting(null); branches.reload(); setNotice({ tone: 'ok', text: 'The office position and network were saved.' }); }} />}
      {adding && <NetworkForm branch={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); branches.reload(); }} />}
    </>
  );
}
