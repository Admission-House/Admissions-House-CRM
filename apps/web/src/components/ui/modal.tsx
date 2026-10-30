'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';

/** A dialog on a dimmed page. Closes with Escape or a click outside, keeps focus inside, and gives focus back. */
export function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea')];
      if (f.length === 0) return;
      const a = f[0]!;
      const z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = '';
      before?.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <button aria-label="Close" className="absolute inset-0 bg-ink/50" onClick={onClose} tabIndex={-1} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className={`relative flex max-h-[92dvh] w-full ${width} flex-col overflow-hidden rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl`}>
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-semibold text-brand">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-mint-soft hover:text-brand"><X className="h-5 w-5" /></button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
