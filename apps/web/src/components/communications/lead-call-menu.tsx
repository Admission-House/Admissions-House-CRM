'use client';

import { Mic, PhoneCall, Users, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errorText } from '@/lib/api';
import type { SessionView } from '@/lib/communications';
import { useDismiss } from '@/lib/use-dismiss';

export interface CallMenuLead {
  id: string;
  name: string;
}

interface Props {
  lead: CallMenuLead;
  /** An ordinary phone call through the calling provider (rings the counsellor's own phone first). */
  /** With `href` (a tel: link) the item opens the phone's own dialer as an ordinary link, and onCall runs as well. */
  phone?: { enabled: boolean; onCall: () => void; label?: string; href?: string };
  /** Voice call, video call and meeting over the internet (the lead gets a link). */
  internet: boolean;
  onMeeting: (lead: CallMenuLead) => void;
  onError: (text: string) => void;
}

/**
 * The phone icon of a lead row. It opens a small menu: a phone call, a voice call, a video call or a
 * meeting. A voice or video call opens the room at once, with the link ready to send to the lead.
 */
export function LeadCallMenu({ lead, phone, internet, onMeeting, onError }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useDismiss(open, box, () => setOpen(false));
  // The menu is drawn on top of the page, not inside the table, so a table's scrolling edge can never cut it off.
  // It opens below the icon, or above it when there is no room underneath, and closes when the page moves.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node)) e.stopPropagation();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('mousedown', outside, true);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('mousedown', outside, true);
    };
  }, [open]);

  function toggle() {
    if (open) return setOpen(false);
    const r = box.current?.getBoundingClientRect();
    if (r) {
      const height = 4 * 40 + 8;
      const top =
        r.bottom + 6 + height > window.innerHeight ? Math.max(8, r.top - 6 - height) : r.bottom + 6;
      setPlace({ top, left: Math.max(8, Math.min(r.right - 224, window.innerWidth - 232)) });
    }
    setOpen(true);
  }

  async function start(kind: 'voice' | 'video') {
    setBusy(true);
    try {
      const made = await api<SessionView>(`/leads/${lead.id}/communications`, {
        method: 'POST',
        body: { kind, maxMinutes: 30, record: true },
      });
      router.push(`/video/${made.id}`);
    } catch (e) {
      onError(errorText(e, 'Cannot reach the server.'));
      setBusy(false);
      setOpen(false);
    }
  }

  const item =
    'flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm text-ink hover:bg-head disabled:opacity-50';
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Call ${lead.name}`}
        title="Call"
        className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-info-50 hover:text-info"
      >
        <PhoneCall className="h-[17px] w-[17px]" />
      </button>
      {open &&
        place &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={`Call ${lead.name}`}
            style={{ position: 'fixed', top: place.top, left: place.left }}
            className="z-[60] w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl"
          >
            {phone?.href && (
              <a
                href={phone.href}
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  phone.onCall();
                }}
              >
                <PhoneCall className="h-4 w-4 text-info" aria-hidden />{' '}
                {phone.label ?? 'Phone call'}
              </a>
            )}
            {phone && !phone.href && (
              <button
                type="button"
                role="menuitem"
                className={item}
                disabled={busy || !phone.enabled}
                onClick={() => {
                  setOpen(false);
                  phone.onCall();
                }}
              >
                <PhoneCall className="h-4 w-4 text-info" aria-hidden />{' '}
                {phone.label ?? 'Phone call'}
              </button>
            )}
            {internet && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  disabled={busy}
                  onClick={() => void start('voice')}
                >
                  <Mic className="h-4 w-4 text-brand" aria-hidden /> Voice call (link)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  disabled={busy}
                  onClick={() => void start('video')}
                >
                  <Video className="h-4 w-4 text-brand" aria-hidden /> Video call (link)
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    onMeeting(lead);
                  }}
                >
                  <Users className="h-4 w-4 text-brand" aria-hidden /> Meeting…
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
