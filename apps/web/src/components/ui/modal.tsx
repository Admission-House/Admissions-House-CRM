'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** A dialog on a dimmed page. Closes with Escape or a click outside, keeps focus inside, and gives focus back. */
export function Modal({
  title,
  onClose,
  children,
  width = 'max-w-lg',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The latest onClose, so a parent that passes a new function on every render does not re-run the effect below
  // (which would move the focus back to the first field while someone is typing).
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const self = box.current;
    const first = self?.querySelector<HTMLElement>('input, select, textarea, button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      // With a dialog opened from another dialog, only the one on top answers the keyboard.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (!box.current || dialogs[dialogs.length - 1] !== box.current) return;
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab') return;
      const f = [
        ...box.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea',
        ),
      ];
      if (f.length === 0) return;
      const a = f[0]!;
      const z = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      // Another dialog may still be open underneath: the page scrolls again only when the last one closes.
      const others = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d !== self);
      if (others.length === 0) document.body.style.overflow = '';
      before?.focus();
    };
  }, []);

  if (typeof document === 'undefined') return null;
  // Drawn on the page itself, not inside whatever opened it. A panel with the frosted-glass look would otherwise hold the dialog
  // inside its own edges, small and cut off (its blur makes it the frame that "fixed" is measured against).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="presentation"
    >
      <button
        aria-label="Close"
        className="absolute inset-0 bg-ink/50"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex max-h-[92dvh] w-full ${width} flex-col overflow-hidden rounded-t-2xl bg-surface shadow-2xl sm:rounded-2xl`}
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="text-lg font-semibold text-brand">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-mint-soft hover:text-brand"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="modal-body overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
