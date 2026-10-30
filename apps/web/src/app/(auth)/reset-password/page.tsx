'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthButton, AuthField, AuthHeading, AuthPassword } from '@/components/auth/auth-form';
import { Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';

function Form() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError(new ApiError(400, 'MISMATCH', 'The two passwords are not the same.', [{ field: 'again', message: 'Must match' }]));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', anonymous: true, body: { token, newPassword: password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return <Notice tone="bad">This reset link is incomplete. Open the link from your email again, or <Link className="underline" href="/forgot-password">ask for a new one</Link>.</Notice>;
  }

  return (
    <div>
      <AuthHeading title="Choose a new password" />
      {done ? (
        <div className="mt-8 space-y-5">
          <Notice tone="ok">Your password has been changed. Sign in with the new one.</Notice>
          <Link href="/login" className="flex h-14 items-center justify-center rounded-xl bg-brand text-base font-semibold text-white hover:bg-brand-700">Go to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-6">
          {error && <Notice tone="bad">{error.message}</Notice>}
          <AuthField label="New password" htmlFor="pw" error={error?.fieldErrors.find((f) => f.field === 'newPassword')?.message}>
            <AuthPassword id="pw" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter new password" autoComplete="new-password" required />
          </AuthField>
          <AuthField label="Type it again" htmlFor="pw2" error={error?.fieldErrors.find((f) => f.field === 'again')?.message}>
            <AuthPassword id="pw2" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Enter it again" autoComplete="new-password" required />
          </AuthField>
          <AuthButton type="submit" loading={busy}>Change password</AuthButton>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <Form />
    </Suspense>
  );
}
