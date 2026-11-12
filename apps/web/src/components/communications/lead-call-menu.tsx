'use client';

import { Mic, PhoneCall, Users, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { SessionView } from '@/lib/communications';

export interface CallMenuLead {
  id: string;
  name: string;
}

interface Props {
  lead: CallMenuLead;
  /** An ordinary phone call through the calling provider (rings the counsellor's own phone first). */
  phone?: { enabled: boolean; onCall: () => void };
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

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  async function start(kind: 'voice' | 'video') {
    setBusy(true);
    try {
      const made = await api<SessionView>(`/leads/${lead.id}/communications`, { method: 'POST', body: { kind, maxMinutes: 30 } });
      router.push(`/video/${made.id}`);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
      setBusy(false);
      setOpen(false);
    }
  }

  const item = 'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-ink hover:bg-head disabled:opacity-50';
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={`Call ${lead.name}`} title="Call"
        className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-info-50 hover:text-info">
        <PhoneCall className="h-[17px] w-[17px]" />
      </button>
      {open && (
        <div role="menu" aria-label={`Call ${lead.name}`} className="absolute right-0 top-9 z-30 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl">
          {phone && (
            <button type="button" role="menuitem" className={item} disabled={busy || !phone.enabled} onClick={() => { setOpen(false); phone.onCall(); }}>
              <PhoneCall className="h-4 w-4 text-info" aria-hidden /> Phone call
            </button>
          )}
          {internet && (
            <>
              <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void start('voice')}><Mic className="h-4 w-4 text-brand" aria-hidden /> Voice call (link)</button>
              <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => void start('video')}><Video className="h-4 w-4 text-brand" aria-hidden /> Video call (link)</button>
              <button type="button" role="menuitem" className={item} disabled={busy} onClick={() => { setOpen(false); onMeeting(lead); }}><Users className="h-4 w-4 text-brand" aria-hidden /> Meeting…</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
