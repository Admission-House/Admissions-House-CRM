'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cx } from '@/components/ui';

/** A small button that copies `value` to the clipboard, for a number or an email address a person wants to paste elsewhere. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // clipboard blocked: the text itself is still selectable
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      title={done ? 'Copied' : `Copy ${label}`}
      className={cx('inline-grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-head hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand', done && 'text-ok', className)}
    >
      {done ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
    </button>
  );
}
