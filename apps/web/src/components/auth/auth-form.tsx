'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/components/ui';

/** Larger controls for the sign-in screens, where people deserve a roomy, unmistakable form. */
const box =
  'h-14 w-full rounded-lg border border-line-strong bg-surface px-5 text-base text-ink placeholder:text-subtle transition focus:border-teal-600 focus:outline-none focus:ring-0 aria-[invalid=true]:border-bad disabled:bg-head';

export function AuthField({ label, htmlFor, error, hint, action, children }: { label: string; htmlFor: string; error?: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-base font-medium text-brand">{label}</label>
        {action}
      </div>
      {children}
      {hint && !error && <p className="mt-1.5 text-sm text-muted">{hint}</p>}
      {error && <p role="alert" className="mt-1.5 text-sm text-bad">{error}</p>}
    </div>
  );
}

export function AuthInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(box, className)} />;
}

export function AuthPassword({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...rest} type={shown ? 'text' : 'password'} className={cx(box, 'pr-14', className)} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid w-14 place-items-center rounded-r-lg text-muted transition hover:text-brand"
      >
        {shown ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
      </button>
    </div>
  );
}

export function AuthButton({ loading, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-brand text-base font-semibold text-white transition hover:bg-brand-700 focus-visible:ring-4 focus-visible:ring-teal/30 disabled:cursor-not-allowed disabled:opacity-60', className)}
    >
      {loading && <Loader2 className="h-5 w-5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <h1 className="text-[40px] font-bold leading-tight tracking-tight text-brand">{title}</h1>
      {subtitle && <p className="mt-2 text-base text-muted">{subtitle}</p>}
    </>
  );
}
