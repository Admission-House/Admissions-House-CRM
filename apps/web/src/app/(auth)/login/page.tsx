'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { AuthButton, AuthField, AuthHeading, AuthInput, AuthPassword } from '@/components/auth/auth-form';
import { Notice } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BRAND } from '@/lib/brand-config';
import { useCompanySlug } from '@/lib/company-slug';

const EMAIL_KEY = 'ah.email';

/** What this device remembers (a convenience; the form works the same without it). */
const readEmail = () => {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
};
const subscribe = (onChange: () => void) => {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
};
const writeEmail = (value: string | null) => {
  try {
    if (value) localStorage.setItem(EMAIL_KEY, value);
    else localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* storage may be blocked; nothing depends on it */
  }
};

/** The message a person should read when signing in did not work. No codes, no technical words. */
function friendly(err: unknown): string {
  if (!(err instanceof ApiError)) return 'We could not reach the server. Check your internet connection and try again.';
  switch (err.code) {
    case 'INVALID_CREDENTIALS': return 'The email or password is not right. Please try again.';
    case 'VALIDATION_FAILED': return err.fieldErrors.some((f) => f.field === 'tenant') ? 'This company address was not found. Please check the link you were given.' : 'Please check your email and password and try again.';
    case 'NETWORK': return 'We could not reach the server. Check your internet connection and try again.';
    default: return err.message;
  }
}

function SignIn() {
  const { login, status } = useAuth();
  const router = useRouter();
  const company = useCompanySlug();
  const savedEmail = useSyncExternalStore(subscribe, readEmail, () => '');
  const [emailTyped, setEmail] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<{ email?: string; password?: string }>({});
  const email = emailTyped ?? savedEmail;

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  /** What is wrong with the form before it is sent, in plain words. */
  function check(): { email?: string; password?: string } {
    const problems: { email?: string; password?: string } = {};
    if (!email.trim()) problems.email = 'Enter your email address.';
    else if (!/^[^s@]+@[^s@]+.[^s@]+$/.test(email.trim())) problems.email = 'Enter a valid email address, for example name@company.com.';
    if (!password) problems.password = 'Enter your password.';
    return problems;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const problems = check();
    setFields(problems);
    if (problems.email || problems.password) {
      document.getElementById(problems.email ? 'email' : 'password')?.focus();
      return;
    }
    setBusy(true);
    try {
      const res = await login({ tenant: company, email: email.trim(), password });
      writeEmail(remember ? email.trim() : null);
      router.replace(res.mustChangePassword ? '/change-password' : '/dashboard');
    } catch (err) {
      setError(friendly(err));
      setBusy(false);
    }
  }

  const forgot = `/forgot-password${company ? `?company=${encodeURIComponent(company)}` : ''}`;
  const links = [
    BRAND.manualUrl && { href: BRAND.manualUrl, label: 'Download user manual' },
    BRAND.helpUrl && { href: BRAND.helpUrl, label: 'Feedback and help' },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <div>
      <AuthHeading title="Welcome Back!" />

      <form onSubmit={submit} className="mt-10 space-y-6" noValidate>
        {error && <Notice tone="bad">{error}</Notice>}

        <AuthField label="Email" htmlFor="email" error={fields.email}>
          <AuthInput id="email" type="email" value={email} aria-invalid={!!fields.email} onChange={(e) => { setEmail(e.target.value); setFields((f) => ({ ...f, email: undefined })); setError(null); }} placeholder="Enter email" autoComplete="username" autoFocus={!email} />
        </AuthField>

        <AuthField
          label="Password"
          htmlFor="password"
          error={fields.password}
          action={<Link href={forgot} className="text-sm font-medium text-brand-600 hover:underline">Forgot password?</Link>}
        >
          <AuthPassword id="password" value={password} aria-invalid={!!fields.password} onChange={(e) => { setPassword(e.target.value); setFields((f) => ({ ...f, password: undefined })); setError(null); }} placeholder="Enter password" autoComplete="current-password" autoFocus={!!email} />
        </AuthField>

        <label className="flex cursor-pointer items-center gap-3 text-[15px] text-brand">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-5 w-5 rounded border-2 border-brand accent-[#063b39]" />
          Remember me on this device
        </label>

        <AuthButton type="submit" loading={busy}>Continue</AuthButton>
      </form>

      <div className="mt-8 space-y-1.5 text-center text-[15px] text-brand">
        {links.map((l) => (
          <p key={l.href}><a href={l.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-brand-600">{l.label}</a></p>
        ))}
        {BRAND.supportEmail && <p className="text-muted">Or reach out to us at <a href={`mailto:${BRAND.supportEmail}`} className="text-brand underline underline-offset-2">{BRAND.supportEmail}</a></p>}
      </div>

      <p className="mt-10 text-center text-[13px] leading-relaxed text-muted">
        Office staff can sign in only from the office. Your browser will ask to share your location, which is used only for that check.
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
