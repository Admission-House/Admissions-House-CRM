'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { twMerge } from 'tailwind-merge';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

/** Joins class names and lets the last one win when two set the same thing (w-full then w-44). */
export const cx = (...parts: (string | false | null | undefined)[]) => twMerge(parts.filter(Boolean).join(' '));

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
type Size = 'sm' | 'md';

export function Button({
  variant = 'primary', size = 'md', loading, className, children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-700 border border-brand',
    accent: 'bg-teal text-brand hover:bg-teal-600 border border-teal font-semibold',
    secondary: 'bg-surface text-ink border border-line-strong hover:bg-head',
    ghost: 'text-muted hover:bg-head hover:text-ink border border-transparent',
    danger: 'bg-surface text-bad border border-bad/40 hover:bg-bad-50',
  };
  const sizes: Record<Size, string> = { sm: 'h-7 px-2.5 text-xs gap-1.5', md: 'h-9 px-3.5 text-sm gap-2' };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55', sizes[size], styles[variant], className)}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const field =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-subtle focus:border-teal-600 focus:outline-none focus:ring-0 disabled:bg-head disabled:text-muted';

export function Field({ label, error, hint, children, htmlFor, labelAction, required }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string; labelAction?: ReactNode; required?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
          {label}
          {required && <span className="text-bad"> *</span>}
        </label>
        {labelAction}
      </div>
      {children}
      {hint && !error && <p className="text-xs text-subtle">{hint}</p>}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(field, 'h-9', className)} />;
}

/** A password box with an eye to show or hide what was typed. */
export function PasswordInput({ className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input {...rest} type={shown ? 'text' : 'password'} className={cx(field, 'h-9 pr-10', className)} />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-muted transition hover:text-brand"
      >
        {shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}

export { Select } from './select';

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(field, 'min-h-20 py-2', className)} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx('rounded-[var(--radius-card)] border border-line bg-surface shadow-card', className)}>{children}</section>;
}

/** A card with a title row, the usual frame for a block of a screen. */
export function Panel({ title, actions, children, className, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <Card className={className}>
      {(title || actions) && (
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </Card>
  );
}

/** The tinted band that starts a section of a long form. */
export function SectionBand({ children }: { children: ReactNode }) {
  return <h3 className="border-y border-teal-600/15 bg-mint-soft px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-brand-600">{children}</h3>;
}

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand';
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-head text-muted ring-line-strong/70',
    ok: 'bg-ok-50 text-ok ring-ok/25',
    warn: 'bg-warn-50 text-warn ring-warn/25',
    bad: 'bg-bad-50 text-bad ring-bad/25',
    info: 'bg-info-50 text-info ring-info/25',
    brand: 'bg-mint-soft text-brand-600 ring-teal-600/25',
  };
  return <span className={cx('inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

/** A small round chip with a count, used for status and queue filters. */
export function Chip({ active, count, children, onClick, dot }: { active?: boolean; count?: number; children: ReactNode; onClick?: () => void; dot?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        active ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-muted hover:border-brand/40 hover:text-ink',
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />}
      {children}
      {count !== undefined && <span className={cx('tabular rounded-full px-1.5 text-xs', active ? 'bg-white/20' : 'bg-head text-ink')}>{count}</span>}
    </button>
  );
}

export function Avatar({ name, size = 32, tone = 'brand' }: { name: string; size?: number; tone?: 'brand' | 'soft' }) {
  const text = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className={cx('grid shrink-0 place-items-center rounded-full font-semibold', tone === 'brand' ? 'bg-brand text-mint' : 'bg-mint text-brand')}
    >
      {text}
    </span>
  );
}

/** Tabs across the top of a workspace. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { key: T; label: string; count?: number }[]; value: T; onChange: (key: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex overflow-x-auto overflow-y-hidden border-b border-line bg-surface">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cx('relative flex shrink-0 items-center gap-1.5 px-5 py-3 text-sm font-medium transition-colors', on ? 'text-brand' : 'text-muted hover:text-ink')}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="tabular rounded-full bg-head px-1.5 text-xs text-ink">{t.count}</span>}
            {on && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-teal" />}
          </button>
        );
      })}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin text-teal-600" aria-hidden />
      {label}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'bad' | 'ok' | 'warn'; children: ReactNode }) {
  const tones = { info: 'border-info/25 bg-info-50 text-info', bad: 'border-bad/25 bg-bad-50 text-bad', ok: 'border-ok/25 bg-ok-50 text-ok', warn: 'border-warn/25 bg-warn-50 text-warn' };
  return <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('rounded-md border px-3 py-2 text-sm', tones[tone])}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-sm text-xs text-muted">{children}</p>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-brand">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
