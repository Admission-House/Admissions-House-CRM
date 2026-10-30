'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { AuthButton, AuthField, AuthHeading, AuthInput } from '@/components/auth/auth-form';
import { Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useCompanySlug } from '@/lib/company-slug';

function Form() {
  const company = useCompanySlug();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setEmailError('Enter your email address.');
    if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email.trim())) return setEmailError('Enter a valid email address, for example name@company.com.');
    setEmailError(undefined);
    setBusy(true);
    try {
      const res = await api<{ message: string }>('/auth/forgot-password', { method: 'POST', anonymous: true, body: { tenant: company, email: email.trim() } });
      setMessage(res.message);
    } catch (err) {
      setError(err instanceof ApiError && err.code !== 'VALIDATION_FAILED' ? err.message : 'We could not send the link. Please check the email address and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <AuthHeading title="Reset your password" subtitle="Enter your email and we will send you a link to choose a new password." />
      {message ? (
        <div className="mt-8 space-y-5">
          <Notice tone="ok">{message}</Notice>
          <Link href="/login" className="inline-block text-[15px] font-semibold text-brand-600 hover:underline">Back to sign in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-6" noValidate>
          {error && <Notice tone="bad">{error}</Notice>}
          <AuthField label="Email" htmlFor="email" error={emailError}>
            <AuthInput id="email" type="email" value={email} aria-invalid={!!emailError} onChange={(e) => { setEmail(e.target.value); setEmailError(undefined); }} placeholder="Enter email" autoFocus />
          </AuthField>
          <AuthButton type="submit" loading={busy}>Send reset link</AuthButton>
          <p className="text-center text-[15px]"><Link href="/login" className="font-semibold text-brand-600 hover:underline">Back to sign in</Link></p>
        </form>
      )}
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <Form />
    </Suspense>
  );
}
