'use client';

import { Video } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { Button, Field, Input, Notice } from '@/components/ui';
import { VideoRoom } from '@/components/video/video-room';
import { api, ApiError } from '@/lib/api';
import { deviceIdFor, type LeaveReason, type PresenceEvent, type RtcJoin, type Snapshot } from '@/lib/communications';
import { fmtDateTime } from '@/lib/format';

interface GuestJoin extends RtcJoin {
  hostName: string;
  companyName: string;
  guestName: string;
}

const WORDS: Record<string, string> = {
  NOT_FOUND: 'This link is not valid. Please use the link you were sent. If it was changed or cancelled, ask for a new one.',
  LINK_EXPIRED: 'This link has expired. Ask for a new one.',
  SESSION_ENDED: 'This session has ended.',
  REMOVED: 'You were taken out of this session.',
  INVITE_USED_ELSEWHERE: 'This link is already in use on another device. Ask the person who sent it to release it, then try again.',
  VIDEO_LIMIT_REACHED: 'Calls are not available right now. The person who invited you will contact you another way.',
  VIDEO_NOT_CONFIGURED: 'Calls are not available right now. The person who invited you will contact you another way.',
  RATE_LIMITED: 'Too many tries. Please wait a minute and try again.',
};

const ENDINGS: Record<LeaveReason, { title: string; text: string; again: boolean }> = {
  left: { title: 'You have left the session', text: 'You can join again while there is time left.', again: true },
  time: { title: 'The session time is over', text: 'Thank you. If you need more time, ask for a new link.', again: false },
  ended: { title: 'The session has ended', text: 'Thank you for joining.', again: false },
  removed: { title: 'You were taken out of this session', text: 'If you think this is a mistake, contact the person who invited you.', again: false },
};

/**
 * Where an outside guest lands from the link they were sent. No sign-in. The session is joined only when
 * the guest presses the button, so opening the link (or a chat app previewing it) does not start anything.
 * The link works from the first device that joins; the browser keeps a random value for that.
 */
export default function MeetPage() {
  const { token } = useParams<{ token: string }>();
  const [join, setJoin] = useState<GuestJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<LeaveReason | null>(null);
  const [name, setName] = useState('');

  // Read once the page is in the browser; the server never sees it until the guest joins.
  const deviceId = useMemo(() => (typeof window === 'undefined' ? '' : deviceIdFor(token)), [token]);

  const call = useCallback(
    (name?: string) => api<GuestJoin>('/video/guest/join', { method: 'POST', body: { token, deviceId, ...(name ? { name } : {}) }, anonymous: true }),
    [token, deviceId],
  );

  async function enter() {
    setBusy(true);
    setError(null);
    try {
      setJoin(await call(name.trim() || undefined));
      setOver(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEETING_NOT_STARTED') {
        const at = typeof e.details?.scheduledFor === 'string' ? fmtDateTime(e.details.scheduledFor) : 'its planned time';
        setError(`This meeting has not started yet. It opens a few minutes before ${at}. Please come back then.`);
      } else {
        setError(e instanceof ApiError ? (WORDS[e.code] ?? e.message) : 'Cannot reach the server. Check your internet and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  // A link that worked a moment ago and now is "not found" has been cancelled: the host took this guest out.
  const renew = useCallback(async (): Promise<RtcJoin> => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND') throw new ApiError(403, 'REMOVED', 'You were taken out of this session.');
      throw e;
    }
  }, [call]);
  const report = useCallback(
    async (event: PresenceEvent): Promise<Snapshot | null> => {
      const gone = (removed: boolean): Snapshot => ({ status: removed ? 'open' : 'ended', outcome: null, secondsLeft: 0, removed, participants: [] });
      try {
        return await api<Snapshot>('/video/guest/presence', { method: 'POST', body: { token, deviceId, event }, anonymous: true });
      } catch (e) {
        // Only a clear answer ends the call. A lost connection or a busy server must not throw anyone out.
        if (e instanceof ApiError && (e.code === 'NOT_FOUND' || e.code === 'REMOVED')) return gone(true);
        if (e instanceof ApiError && (e.code === 'SESSION_ENDED' || e.code === 'LINK_EXPIRED')) return gone(false);
        return null;
      }
    },
    [token, deviceId],
  );
  const onLeft = useCallback((reason: LeaveReason) => {
    setOver(reason);
    setJoin(null);
  }, []);

  const ending = over ? ENDINGS[over] : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col justify-center gap-5 px-4 py-8">
      {join ? (
        <div className="glass rounded-2xl p-4 sm:p-6">
          <h1 className="mb-1 text-base font-semibold text-ink">{join.title ?? `Counselling with ${join.hostName}`}</h1>
          <p className="mb-4 text-sm text-muted">{join.companyName} · hosted by {join.hostName}</p>
          <VideoRoom join={join} renew={renew} report={report} onLeft={onLeft} label={`${join.kind === 'voice' ? 'Voice' : 'Video'} call with ${join.hostName}`} />
        </div>
      ) : (
        <div className="glass mx-auto w-full max-w-md rounded-2xl px-6 py-9 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-mint text-brand"><Video className="h-6 w-6" aria-hidden /></span>
          <h1 className="text-lg font-semibold text-ink">{ending ? ending.title : 'You are invited to a session'}</h1>
          <p className="mt-2 text-sm text-muted">
            {ending
              ? ending.text
              : 'Your microphone (and camera, for a video call) is used only during this call. When you are ready, press the button below and allow it when your browser asks.'}
          </p>
          {!ending && (
            <div className="mt-5 text-left">
              <Field label="Your name (shown to the others)" htmlFor="gname" hint="Optional. Leave it if the name is right.">
                <Input id="gname" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
              </Field>
            </div>
          )}
          {error && <div className="mt-4 text-left"><Notice tone="bad">{error}</Notice></div>}
          {(!ending || ending.again) && (
            <Button className="mt-6 w-full" variant="primary" onClick={() => void enter()} loading={busy}>
              {ending?.again ? 'Join again' : 'Join the call'}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
