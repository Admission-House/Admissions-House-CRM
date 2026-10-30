'use client';

import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, Field, Input, Notice, Panel, Spinner } from '@/components/ui';
import { CompanyLogo } from '@/components/company-logo';
import { api, apiRaw, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

interface Company { name: string; productName: string; contactEmail: string | null; brandColor: string | null; accentColor: string | null; hasLogo: boolean }

const DEFAULT_BRAND = '#063b39';
const DEFAULT_ACCENT = '#00dfc2';
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

function ColourField({ id, label, value, fallback, onChange, error }: { id: string; label: string; value: string | null; fallback: string; onChange: (v: string | null) => void; error?: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} hint={value ? undefined : 'Using the product colour'}>
      <div className="flex items-center gap-3">
        <input id={id} type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} className="h-10 w-14 cursor-pointer rounded-lg border border-line-strong bg-surface p-1" />
        <code className="text-sm text-muted">{value ?? fallback}</code>
        {value && <button type="button" onClick={() => onChange(null)} className="text-sm font-medium text-brand-600 hover:underline">Use the default</button>}
      </div>
    </Field>
  );
}

export default function CompanyPage() {
  const { reload } = useAuth();
  const company = useApi<Company>('/company');
  const [draft, setDraft] = useState<Partial<Company>>({});
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ApiError['fieldErrors']>([]);
  const file = useRef<HTMLInputElement>(null);

  if (company.error) return <Notice tone="bad">{company.error.message}</Notice>;
  if (!company.data) return <Spinner />;
  const c = { ...company.data, ...draft };
  const set = <K extends keyof Company>(k: K, v: Company[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const fe = (n: string) => fieldErrors.find((f) => f.field === n)?.message;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    setFieldErrors([]);
    try {
      const { hasLogo: _ignored, ...body } = draft as Company;
      void _ignored;
      await api('/company', { method: 'PUT', body });
      setDraft({});
      company.reload();
      await reload();
      setMsg({ tone: 'ok', text: 'Saved. The new look is on every screen now.' });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function upload(f: File) {
    setLogoBusy(true);
    setMsg(null);
    try {
      const form = new FormData();
      form.set('file', f);
      await apiRaw('/company/logo', { method: 'POST', body: form });
      company.reload();
      await reload();
      setMsg({ tone: 'ok', text: 'The logo was changed.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setLogoBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    setMsg(null);
    try {
      await api('/company/logo', { method: 'DELETE' });
      company.reload();
      await reload();
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      <Panel title="Logo">
        <div className="flex flex-wrap items-center gap-6">
          <div className="grid h-20 min-w-32 place-items-center rounded-lg border border-line bg-head px-4"><CompanyLogo size={56} /></div>
          <div className="space-y-2">
            <p className="text-sm text-muted">Shown at the top of every screen. A JPG or PNG up to 512 KB; a square or wide picture with a clear background looks best.</p>
            <input ref={file} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label="Logo file" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" loading={logoBusy} onClick={() => file.current?.click()}><ImageUp className="h-3.5 w-3.5" aria-hidden /> {company.data.hasLogo ? 'Change logo' : 'Upload logo'}</Button>
              {company.data.hasLogo && <Button variant="ghost" size="sm" disabled={logoBusy} onClick={() => void removeLogo()}><Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove</Button>}
            </div>
          </div>
        </div>
      </Panel>

      <form onSubmit={save} className="space-y-6">
        <Panel title="Names and contact">
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <Field label="Company name" htmlFor="cn" required error={fe('name')}><Input id="cn" value={c.name} onChange={(e) => set('name', e.target.value)} required minLength={2} maxLength={80} /></Field>
            <Field label="Name of the CRM" htmlFor="cp" required error={fe('productName')} hint="Shown in the top bar"><Input id="cp" value={c.productName} onChange={(e) => set('productName', e.target.value)} required minLength={2} maxLength={80} /></Field>
            <Field label="Support email" htmlFor="ce" error={fe('contactEmail')} hint="Shown to people who need help"><Input id="ce" type="email" value={c.contactEmail ?? ''} onChange={(e) => set('contactEmail', e.target.value.trim() === '' ? null : e.target.value)} /></Field>
          </div>
        </Panel>

        <Panel title="Colours">
          <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
            <ColourField id="cb" label="Main colour" value={c.brandColor} fallback={DEFAULT_BRAND} onChange={(v) => set('brandColor', v)} error={fe('brandColor')} />
            <ColourField id="ca" label="Accent colour" value={c.accentColor} fallback={DEFAULT_ACCENT} onChange={(v) => set('accentColor', v)} error={fe('accentColor')} />
          </div>
          <p className="mt-4 text-xs text-muted">The main colour is used for the menu, buttons and headings; the accent for highlights. Pick strong, dark colours for the main one so white text stays readable.</p>
        </Panel>

        <Button type="submit" loading={busy} disabled={Object.keys(draft).length === 0}>Save changes</Button>
      </form>
    </div>
  );
}
