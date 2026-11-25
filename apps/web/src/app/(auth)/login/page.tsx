'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { AuthButton, AuthField, AuthHeading, AuthInput, AuthPassword } from '@/components/auth/auth-form';
import { Notice } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { BRAND } from '@/lib/brand-config';
import { useCompanySlug } from '@/lib/company-slug';
import { forgetCompany, rememberCompany } from '@/lib/login-path';
import { homePath } from '@/lib/start-page';

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
    case 'MFA_REQUIRED': return 'Enter the 6-digit code from your authenticator app to finish signing in.';
    case 'MFA_CODE_WRONG': return 'That code is not right. Use the newest code in your app, or a recovery code.';
    case 'OUTSIDE_OFFICE': return err.details?.canRequestApproval ? 'You are outside the office. You can ask your Super Admin or Admin to let you sign in today.' : err.message;
    case 'NETWORK': return 'We could not reach the server. Check your internet connection and try again.';
    default: return err.message;
  }
}

function SignIn() {
  const { login, status, me } = useAuth();
  const router = useRouter();
  const company = useCompanySlug();
  // Signed out on this page: from here the company link in the address bar decides.
  useEffect(() => {
    if (status === 'anonymous') forgetCompany();
  }, [status]);
  const savedEmail = useSyncExternalStore(subscribe, readEmail, () => '');
  const [emailTyped, setEmail] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [fields, setFields] = useState<{ email?: string; password?: string }>({});
  const email = emailTyped ?? savedEmail;
  // The two-step code, once it has been asked for and typed.
  const code = needsCode ? mfaCode.trim() || undefined : undefined;
  // Outside the office: ask for approval, then wait for the answer (see the panels below the form).
  const [approval, setApproval] = useState<null | { stage: 'ask' } | { stage: 'waiting'; requestId: string; pollToken: string; expiresAt: string } | { stage: 'answered'; state: 'rejected' | 'expired'; by: string | null }>(null);
  const [remoteReason, setRemoteReason] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status === 'authenticated') router.replace(homePath(me?.user.startPage));
  }, [status, router, me]);

  /** What is wrong with the form before it is sent, in plain words. */
  function check(): { email?: string; password?: string } {
    const problems: { email?: string; password?: string } = {};
    if (!email.trim()) problems.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) problems.email = 'Enter a valid email address, for example name@company.com.';
    if (!password) problems.password = 'Enter your password.';
    return problems;
  }

  async function finish(mfa?: string) {
    const res = await login({ tenant: company, email: email.trim(), password, ...(mfa && { mfaCode: mfa }) });
    writeEmail(remember ? email.trim() : null);
    rememberCompany(company);
    router.replace(res.mustChangePassword ? '/change-password' : res.home);
  }

  async function askApproval() {
    if (remoteReason.trim().length < 2) { setError('Write why you are outside the office, for example "College visit".'); return; }
    setBusy(true);
    setError(null);
    try {
      // Already approved earlier today: this simply signs in.
      await finish(code);
    } catch (first) {
      if (!(first instanceof ApiError && first.code === 'OUTSIDE_OFFICE')) { setError(friendly(first)); setBusy(false); return; }
      try {
        await login({ tenant: company, email: email.trim(), password, remoteReason: remoteReason.trim(), ...(code && { mfaCode: code }) });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'REMOTE_APPROVAL_PENDING' && err.details) {
          const d = err.details as { requestId: string; pollToken: string; expiresAt: string };
          setNow(Date.now());
          setApproval({ stage: 'waiting', requestId: d.requestId, pollToken: d.pollToken, expiresAt: d.expiresAt });
        } else {
          setError(friendly(err));
        }
      }
      setBusy(false);
    }
  }

  // While waiting, ask every few seconds how the request stands; once approved, sign in as usual.
  const waiting = approval?.stage === 'waiting' ? approval : null;
  const waitingId = waiting?.requestId;
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      setNow(Date.now());
      try {
        const r = await api<{ state: 'pending' | 'approved' | 'rejected' | 'expired'; decidedBy: string | null }>('/auth/remote-signin/status', {
          method: 'POST', anonymous: true, body: { tenant: company, requestId: waiting.requestId, token: waiting.pollToken },
        });
        if (stopped) return;
        if (r.state === 'approved') {
          stopped = true;
          setBusy(true);
          try {
            await finish(code);
          } catch (err) {
            setApproval(null);
            setError(friendly(err));
            setBusy(false);
          }
          return;
        }
        if (r.state === 'rejected' || r.state === 'expired') { setApproval({ stage: 'answered', state: r.state, by: r.decidedBy }); return; }
      } catch {
        /* a dropped connection: try again on the next tick */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 3000);
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
    // One poll loop for each request; the values it reads stay the same while it waits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingId]);

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
    setApproval(null);
    try {
      await finish(code);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'MFA_REQUIRED' || err.code === 'MFA_CODE_WRONG')) {
        setNeedsCode(true);
        document.getElementById('mfa-code')?.focus();
      }
      if (err instanceof ApiError && err.code === 'OUTSIDE_OFFICE' && err.details?.canRequestApproval) setApproval({ stage: 'ask' });
      setError(friendly(err));
      setBusy(false);
    }
  }

  const left = waiting ? Math.max(0, Math.round((new Date(waiting.expiresAt).getTime() - now) / 1000)) : 0;

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

        {needsCode && (
          <AuthField label="Code from your authenticator app" htmlFor="mfa-code">
            <AuthInput id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={mfaCode} onChange={(e) => { setMfaCode(e.target.value); setError(null); }} placeholder="6-digit code, or a recovery code" autoFocus />
          </AuthField>
        )}

        <label className="flex cursor-pointer items-center gap-3 text-[15px] text-brand">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-5 w-5 rounded border-2 border-brand accent-[#063b39]" />
          Remember me on this device
        </label>

        {!approval && <AuthButton type="submit" loading={busy}>Continue</AuthButton>}
      </form>

      {approval?.stage === 'ask' && (
        <div className="mt-6 space-y-4 rounded-lg border border-line bg-surface p-4">
          <AuthField label="Why are you outside the office today?" htmlFor="remote-reason">
            <AuthInput id="remote-reason" value={remoteReason} maxLength={300} onChange={(e) => { setRemoteReason(e.target.value); setError(null); }} placeholder="For example: College visit, working from home" autoFocus />
          </AuthField>
          <AuthButton type="button" loading={busy} onClick={() => void askApproval()}>Request approval</AuthButton>
          <button type="button" onClick={() => { setApproval(null); setError(null); }} className="w-full text-center text-sm font-medium text-muted hover:text-ink">Cancel</button>
        </div>
      )}

      {waiting && (
        <div className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-5 text-center" role="status" aria-live="polite">
          <span className="mx-auto block h-8 w-8 animate-spin rounded-full border-[3px] border-line border-t-brand" aria-hidden />
          <p className="text-base font-semibold text-brand">Waiting for approval…</p>
          <p className="text-sm text-muted">Your Super Admin and Admin have been told. Keep this page open: you will be signed in as soon as someone approves.</p>
          <p className="tabular text-xs text-subtle">The request expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
          <button type="button" onClick={() => setApproval(null)} className="text-sm font-medium text-muted hover:text-ink">Cancel</button>
        </div>
      )}

      {approval?.stage === 'answered' && (
        <div className="mt-6 space-y-3 rounded-lg border border-line bg-surface p-5 text-center">
          <p className="text-base font-semibold text-brand">{approval.state === 'rejected' ? `Not approved${approval.by ? ` by ${approval.by}` : ''}` : 'Nobody answered in time'}</p>
          <p className="text-sm text-muted">{approval.state === 'rejected' ? 'Please speak to your Super Admin or Admin.' : 'You can ask again.'}</p>
          <AuthButton type="button" onClick={() => setApproval({ stage: 'ask' })}>Ask again</AuthButton>
        </div>
      )}

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
