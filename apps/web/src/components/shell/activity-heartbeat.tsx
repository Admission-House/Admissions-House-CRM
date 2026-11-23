'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';

/** How often, at most, the server is told the person is working. Well inside the idle limit (15 minutes by default). */
const EVERY_MS = 2 * 60_000;

/**
 * Tells the server the person is working on the page (mouse, keys, scrolling, touch) even when nothing is being saved, such
 * as while reading a lead or talking on the phone with it open. Only the server's own calls counted before, so reading for
 * 15 minutes ended in an idle sign-out. Nothing is sent when the tab is hidden or nobody has touched it.
 */
export function ActivityHeartbeat() {
  useEffect(() => {
    let lastInput = 0;
    let lastSent = Date.now();
    const seen = () => { lastInput = Date.now(); };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, seen, { passive: true, capture: true });
    const timer = setInterval(() => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || lastInput <= lastSent || now - lastSent < EVERY_MS) return;
      lastSent = now;
      void api('/auth/activity', { method: 'POST' }).catch(() => undefined);
    }, 15_000);
    return () => {
      clearInterval(timer);
      for (const e of events) window.removeEventListener(e, seen, { capture: true });
    };
  }, []);
  return null;
}
