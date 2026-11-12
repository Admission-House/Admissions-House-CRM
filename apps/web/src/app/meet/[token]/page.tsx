'use client';

import { Video } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { VideoRoom, type RtcJoin } from '@/components/video/video-room';
import { api, ApiError } from '@/lib/api';

interface GuestJoin extends RtcJoin {
  counsellorName: string;
  companyName: string;
  firstName: string;
}

const WORDS: Record<string, string> = {
  NOT_FOUND: 'This link is not valid. Please use the link your counsellor sent you.',
  LINK_EXPIRED: 'This link has expired. Ask your counsellor for a new one.',
  SESSION_ENDED: 'This video session has ended.',
  VIDEO_LIMIT_REACHED: 'Video is not available right now. Your counsellor will contact you by phone.',
  VIDEO_NOT_CONFIGURED: 'Video is not available right now. Your counsellor will contact you by phone.',
  RATE_LIMITED: 'Too many tries. Please wait a minute and try again.',
};

/**
 * Where a student lands from the link their counsellor sent. No sign-in. The session is joined only when
 * the student presses the button, so opening the link (or a chat app previewing it) does not start the clock.
 */
export default function MeetPage() {
  const { token } = useParams<{ token: string }>();
  const [join, setJoin] = useState<GuestJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<null | 'left' | 'time'>(null);

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      setJoin(await api<GuestJoin>('/video/guest/join', { method: 'POST', body: { token }, anonymous: true }));
      setOver(null);
    } catch (e) {
      setError(e instanceof ApiError ? (WORDS[e.code] ?? e.message) : 'Cannot reach the server. Check your internet and try again.');
    } finally {
      setBusy(false);
    }
  }

  const onLeft = useCallback((reason: 'left' | 'time') => {
    setOver(reason);
    setJoin(null);
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-5 px-4 py-8">
      {join ? (
        <div className="glass rounded-2xl p-4 sm:p-6">
          <h1 className="mb-1 text-base font-semibold text-ink">Counselling with {join.counsellorName}</h1>
          <p className="mb-4 text-sm text-muted">{join.companyName}</p>
          <VideoRoom join={join} onLeft={onLeft} label={`Video call with ${join.counsellorName}`} />
        </div>
      ) : (
        <div className="glass mx-auto w-full max-w-md rounded-2xl px-6 py-9 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-mint text-brand"><Video className="h-6 w-6" aria-hidden /></span>
          <h1 className="text-lg font-semibold text-ink">{over ? (over === 'time' ? 'The session time is over' : 'You have left the session') : 'Your counselling session'}</h1>
          <p className="mt-2 text-sm text-muted">
            {over === 'time'
              ? 'Thank you. If you need more time, ask your counsellor for a new link.'
              : 'Your camera and microphone are used only during this call. When you are ready, press the button below and allow them when your browser asks.'}
          </p>
          {error && <div className="mt-4 text-left"><Notice tone="bad">{error}</Notice></div>}
          {over !== 'time' && (
            <Button className="mt-6 w-full" variant="primary" onClick={() => void enter()} loading={busy}>
              {over === 'left' ? 'Join again' : 'Join video call'}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
