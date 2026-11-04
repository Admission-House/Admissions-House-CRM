'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, Notice, Panel, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi } from '@/lib/use-api';

type Policy = 'none' | 'super_admin' | 'admins';

const OPTIONS: { key: Policy; label: string; hint: string }[] = [
  { key: 'none', label: 'Each person chooses', hint: 'Anyone can turn it on under My account. Nobody is required to.' },
  { key: 'super_admin', label: 'Super Admins must use it', hint: 'The accounts that see everything: salaries, all leads and all recordings. Recommended.' },
  { key: 'admins', label: 'Super Admins and Admins must use it', hint: 'Counsellors are not asked.' },
];

export default function SecurityPage() {
  const current = useApi<{ requireTwoStep: Policy }>('/company/security');
  const [choice, setChoice] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string; needsOwn?: boolean } | null>(null);

  if (current.error) return <Notice tone="bad">{current.error.message}</Notice>;
  if (!current.data) return <Spinner />;

  const selected = choice ?? current.data.requireTwoStep;
  const changed = selected !== current.data.requireTwoStep;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await api('/company/security', { method: 'PUT', body: { requireTwoStep: selected } });
      setChoice(null);
      current.reload();
      setMessage({ tone: 'ok', text: selected === 'none' ? 'Saved. Nobody is required to use two-step sign-in.' : 'Saved. People it covers are asked to set it up the next time they use the CRM.' });
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.', needsOwn: e instanceof ApiError && e.code === 'SET_UP_YOUR_OWN_FIRST' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="max-w-2xl space-y-4">
        {message && (
          <Notice tone={message.tone}>
            {message.text}
            {message.needsOwn && <> <Link href="/account" className="font-medium underline">Go to My account</Link></>}
          </Notice>
        )}
        <Panel title="Two-step sign-in">
          <p className="text-sm text-muted">After the password, a person gives a six-digit code from an authenticator app on their phone. Someone who learns a password still cannot sign in.</p>
          <fieldset className="mt-4 space-y-2">
            <legend className="sr-only">Who must use two-step sign-in</legend>
            {OPTIONS.map((o) => (
              <label key={o.key} className="flex cursor-pointer items-start gap-3 rounded-md border border-line p-3 hover:bg-head has-[:checked]:border-brand-600 has-[:checked]:bg-mint-50">
                <input type="radio" name="policy" value={o.key} checked={selected === o.key} onChange={() => setChoice(o.key)} className="mt-1 h-4 w-4 accent-[#0f625e]" />
                <span>
                  <span className="block text-sm font-medium text-ink">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {selected !== 'none' && (
            <div className="mt-4 space-y-2 text-xs text-muted">
              <p>You must have set up your own first, because this setting covers you.</p>
              <p>Someone who lost their phone can be reset by a Super Admin on their page under Users. They then set it up again.</p>
              <p>The mobile app cannot set it up yet, so people it covers can use only the web CRM for now.</p>
            </div>
          )}
          <div className="mt-5"><Button loading={busy} disabled={!changed} onClick={() => void save()}>Save</Button></div>
        </Panel>
      </div>
    </>
  );
}
