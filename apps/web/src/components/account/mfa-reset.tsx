'use client';

import { useState } from 'react';
import { Button, Notice, Panel } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

/** For someone who lost their phone: switches off their two-step sign-in so they can sign in and set it up again. */
export function MfaReset({ userId }: { userId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad' | 'info'; text: string } | null>(null);

  async function reset() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<{ reset: boolean }>(`/users/${userId}/mfa/reset`, { method: 'POST', body: {} });
      setMessage(res.reset ? { tone: 'ok', text: 'Two-step sign-in was switched off for this person. They can sign in with their password and set it up again.' } : { tone: 'info', text: 'This person did not have two-step sign-in on.' });
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Two-step sign-in">
      <div className="space-y-3">
        <p className="max-w-xl text-sm text-muted">If this person lost their phone, switch off their two-step sign-in. It is written to the audit log.</p>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <Button variant="secondary" loading={busy} onClick={() => void reset()}>Switch off two-step sign-in</Button>
      </div>
    </Panel>
  );
}
