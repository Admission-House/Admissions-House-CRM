'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthButton, AuthField, AuthHeading, AuthPassword } from '@/components/auth/auth-form';
import { Notice, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Shown after a first sign-in with a one-time password, and reachable later from the account menu. */
export default function ChangePasswordPage() {
  const { status, me, reload } = useAuth();
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') return <Spinner />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError(new ApiError(400, 'MISMATCH', 'The two passwords are not the same.', [{ field: 'again', message: 'Must match' }]));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: password } });
      await reload();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'NETWORK', 'Cannot reach the server. Try again.'));
      setBusy(false);
    }
  }

  const fe = (n: string) => error?.fieldErrors.find((f) => f.field === n)?.message;
  return (
    <div>
      <AuthHeading
        title="Change your password"
        subtitle={me?.user.mustChangePassword ? 'You signed in with a one-time password. Choose your own before you continue.' : 'Choose a new password.'}
      />
      <form onSubmit={submit} className="mt-8 space-y-6">
        {error && <Notice tone="bad">{error.message}</Notice>}
        <AuthField label="Current password" htmlFor="cur" error={fe('currentPassword')}>
          <AuthPassword id="cur" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Enter current password" autoComplete="current-password" required />
        </AuthField>
        <AuthField label="New password" htmlFor="pw" error={fe('newPassword')}>
          <AuthPassword id="pw" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter new password" autoComplete="new-password" required />
        </AuthField>
        <AuthField label="Type it again" htmlFor="pw2" error={fe('again')}>
          <AuthPassword id="pw2" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Enter it again" autoComplete="new-password" required />
        </AuthField>
        <AuthButton type="submit" loading={busy}>Change password</AuthButton>
      </form>
    </div>
  );
}
