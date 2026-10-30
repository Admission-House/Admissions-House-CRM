'use client';

import { useState } from 'react';
import { Button, Field, Input, Notice, Panel, Spinner, Textarea } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Profile {
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  joinedOn: string | null;
  designation: string | null;
  dateOfBirth: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  bankIfsc: string | null;
}

type Draft = { designation: string; dateOfBirth: string; address: string; emergencyContactName: string; emergencyContactPhone: string; bankName: string; bankAccountNo: string; bankIfsc: string };

const start = (p: Profile): Draft => ({
  designation: p.designation ?? '', dateOfBirth: p.dateOfBirth ?? '', address: p.address ?? '', emergencyContactName: p.emergencyContactName ?? '',
  emergencyContactPhone: p.emergencyContactPhone ?? '', bankName: p.bankName ?? '', bankAccountNo: '', bankIfsc: p.bankIfsc ?? '',
});

/**
 * One person's employee details: the sign-in details are shown, the rest can be edited. People edit
 * their own address, emergency contact and bank details; whoever manages people also edits the HR
 * details. A bank account number is shown masked, and is replaced only when a new one is typed.
 */
export function EmployeeProfile({ path, canEditHr, title }: { path: string; canEditHr: boolean; title?: string }) {
  const profile = useApi<Profile>(path);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  if (profile.error) return <Notice tone="bad">{profile.error.message}</Notice>;
  if (!profile.data) return <Spinner />;
  const p = profile.data;
  const d = draft ?? start(p);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...d, [k]: e.target.value });
  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const base = start(p);
    const changed: Record<string, string | null> = {};
    for (const k of Object.keys(d) as (keyof Draft)[]) {
      if (!canEditHr && (k === 'designation' || k === 'dateOfBirth')) continue;
      if (d[k] !== base[k]) changed[k] = d[k].trim() === '' ? null : d[k].trim();
    }
    if (Object.keys(changed).length === 0) {
      setBusy(false);
      setSaved(true);
      return;
    }
    try {
      await api(path, { method: 'PUT', body: changed });
      setDraft(null);
      profile.reload();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      {saved && <Notice tone="ok">Saved.</Notice>}
      {error && <Notice tone="bad">{error.message}</Notice>}

      <Panel title={title ?? 'Sign-in details'}>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          {[['Name', p.name], ['Email', p.email], ['Mobile', p.phone ?? '—'], ['Joined on', p.joinedOn ? fmtDate(p.joinedOn) : '—']].map(([k, v]) => (
            <div key={k}><dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k}</dt><dd className="mt-1 break-words text-sm font-medium">{v}</dd></div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted">Name, email and mobile number are changed from Settings, Users.</p>
      </Panel>

      <Panel title="Personal and work">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <Field label="Designation" htmlFor="pd" error={fe('designation')} hint={canEditHr ? undefined : 'Set by your administrator'}><Input id="pd" value={d.designation} onChange={set('designation')} disabled={!canEditHr} maxLength={80} /></Field>
          <Field label="Date of birth" htmlFor="pb" error={fe('dateOfBirth')} hint={canEditHr ? undefined : 'Set by your administrator'}><Input id="pb" type="date" value={d.dateOfBirth} onChange={set('dateOfBirth')} disabled={!canEditHr} /></Field>
          <div className="sm:col-span-2"><Field label="Address" htmlFor="pa" error={fe('address')}><Textarea id="pa" value={d.address} onChange={set('address')} maxLength={500} /></Field></div>
        </div>
      </Panel>

      <Panel title="Emergency contact">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="en" error={fe('emergencyContactName')}><Input id="en" value={d.emergencyContactName} onChange={set('emergencyContactName')} maxLength={80} /></Field>
          <Field label="Mobile number" htmlFor="ep" error={fe('emergencyContactPhone')}><Input id="ep" inputMode="tel" value={d.emergencyContactPhone} onChange={set('emergencyContactPhone')} /></Field>
        </div>
      </Panel>

      <Panel title="Bank details">
        <div className="grid max-w-3xl gap-4 sm:grid-cols-3">
          <Field label="Bank" htmlFor="bn" error={fe('bankName')}><Input id="bn" value={d.bankName} onChange={set('bankName')} maxLength={80} /></Field>
          <Field label="Account number" htmlFor="ba" error={fe('bankAccountNo')} hint={p.bankAccountNo ? `Saved: ${p.bankAccountNo}. Type a new number only to replace it.` : 'Digits only'}>
            <Input id="ba" inputMode="numeric" value={d.bankAccountNo} onChange={set('bankAccountNo')} placeholder={p.bankAccountNo ?? ''} autoComplete="off" />
          </Field>
          <Field label="IFSC" htmlFor="bi" error={fe('bankIfsc')} hint="For example HDFC0001234"><Input id="bi" value={d.bankIfsc} onChange={(e) => setDraft({ ...d, bankIfsc: e.target.value.toUpperCase() })} maxLength={11} autoComplete="off" /></Field>
        </div>
        <p className="mt-4 text-xs text-muted">The account number and IFSC are stored encrypted. Only you and the people who enter salaries can see them.</p>
      </Panel>

      <Button type="submit" loading={busy}>Save details</Button>
    </form>
  );
}
