'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** Closes a popup when the person presses outside it or presses Escape. Listens only while the popup is open. */
export function useDismiss(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  // The latest callback, so the listeners are not set up again on every render.
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) latest.current();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, box]);
}
