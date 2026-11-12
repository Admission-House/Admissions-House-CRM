'use client';

import { ArrowLeft, Check, Copy, MessageCircle } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PeoplePanel } from '@/components/communications/people-panel';
import { Badge, Button, Card, Notice, Spinner } from '@/components/ui';
import { VideoRoom } from '@/components/video/video-room';
import { api, ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { OUTCOME_TEXT, PHASE_TEXT, type LeaveReason, type PresenceEvent, type RtcJoin, type SessionDetail, type Snapshot } from '@/lib/communications';
import { useRealtime } from '@/lib/realtime';
import { useApi } from '@/lib/use-api';

const WORDS: Record<string, string> = {
  SESSION_ENDED: 'This session has ended.',
  REMOVED: 'You were taken out of this session.',
  VIDEO_LIMIT_REACHED: 'The calling minutes for this month are used up. Use a phone call, or try again next month.',
  VIDEO_NOT_CONFIGURED: 'Calls and meetings are not set up yet.',
  NOT_FOUND: 'This session was not found, or you may not open it.',
};

const ENDINGS: Record<LeaveReason, string> = {
  left: 'You have left the call.',
  time: 'The time for this session is over.',
  ended: 'The session has ended.',
  removed: 'You were taken out of this session.',
};

/** A call or meeting for staff: the room, the people, and the host's controls. */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const detail = useApi<SessionDetail>(`/communications/${id}`);
  const [join, setJoin] = useState<RtcJoin | null>(null);
  const [error, setError] = useState<{ code: string; text: string } | null>(null);
  const [over, setOver] = useState<LeaveReason | null>(null);
  const [ending, setEnding] = useState(false);
  const asked = useRef(false);

  const enter = useCallback(async () => {
    setError(null);
    try {
      setJoin(await api<RtcJoin>(`/communications/${id}/join`, { method: 'POST', body: {} }));
      setOver(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MEETING_NOT_STARTED') {
        const at = typeof e.details?.scheduledFor === 'string' ? fmtDateTime(e.details.scheduledFor) : 'its planned time';
        setError({ code: e.code, text: `This meeting has not started yet. It opens a few minutes before ${at}.` });
      } else {
        setError({ code: e instanceof ApiError ? e.code : 'NETWORK', text: e instanceof ApiError ? (WORDS[e.code] ?? e.message) : 'Cannot reach the server.' });
      }
    }
  }, [id]);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void enter();
  }, [enter]);

  // The session changes under us: someone answers, joins, is added. A hint from the server, and a slow timer as a fallback.
  useRealtime(['call'], detail.reload, 1_500);
  useEffect(() => {
    const t = setInterval(detail.reload, 15_000);
    return () => clearInterval(t);
  }, [detail.reload]);

  const renew = useCallback(() => api<RtcJoin>(`/communications/${id}/join`, { method: 'POST', body: {} }), [id]);
  const report = useCallback((event: PresenceEvent) => api<Snapshot>(`/communications/${id}/presence`, { method: 'POST', body: { event } }).catch(() => null), [id]);
  const onLeft = useCallback((reason: LeaveReason) => setOver(reason), []);
  const reload = detail.reload;
  const onSnapshot = useCallback(() => reload(), [reload]);

  async function end() {
    setEnding(true);
    try {
      await api(`/communications/${id}/end`, { method: 'POST', body: {} });
      router.push('/communications');
    } catch (e) {
      setError({ code: 'END', text: e instanceof ApiError ? e.message : 'Cannot reach the server.' });
      setEnding(false);
    }
  }

  const s = detail.data;
  // The lead has been given a link but has not joined: the counsellor is reminded to send it, to the lead's own number.
  const waitingGuest = s?.participants.find((p) => p.kind === 'guest' && p.link && p.state === 'invited');
  const lead = useApi<{ phone: string }>(s?.leadId && waitingGuest ? `/leads/${s.leadId}` : null);
  const leadPhone = lead.data?.phone;
  const [copiedLink, setCopiedLink] = useState(false);
  async function copyLink() {
    if (!waitingGuest?.link) return;
    try {
      await navigator.clipboard.writeText(waitingGuest.link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      setError({ code: 'COPY', text: 'Could not copy. Copy the link from the People list.' });
    }
  }
  const ringing = s?.participants.filter((p) => p.state === 'ringing') ?? [];
  const title = s?.title ?? (s?.leadName ? `${s.kind === 'voice' ? 'Voice' : 'Video'} call about ${s.leadName}` : s ? `${s.kind === 'voice' ? 'Voice' : 'Video'} call` : 'Session');

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <button type="button" onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden /> Back</button>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {s && <Badge tone={s.status === 'open' ? 'brand' : 'neutral'}>{s.status === 'ended' && s.outcome ? OUTCOME_TEXT[s.outcome] : PHASE_TEXT[s.phase]}</Badge>}
        {s?.type === 'meeting' && <Badge tone="info">Meeting</Badge>}
      </div>
      {s?.description && <p className="text-sm text-muted">{s.description}</p>}
      {error && (
        <Notice tone="bad">
          {error.text}{' '}
          {error.code === 'MEETING_NOT_STARTED' && <button type="button" className="font-medium underline" onClick={() => void enter()}>Try again</button>}
        </Notice>
      )}
      {ringing.length > 0 && !over && <Notice tone="info">Ringing {ringing.map((p) => p.name).join(', ')}…</Notice>}
      {s && s.canManage && s.status === 'open' && s.leadId && waitingGuest && !over && (
        <Card className="flex flex-wrap items-center gap-3 border-brand/30 bg-mint/40 p-3">
          <p className="min-w-0 flex-1 text-sm text-ink">Send the link to <span className="font-semibold">{waitingGuest.name}</span> so they can join{s.leadName ? ` (${s.leadName})` : ''}.</p>
          <a className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-3.5 text-sm font-medium text-white hover:bg-brand-700" target="_blank" rel="noopener noreferrer"
            href={`https://wa.me/${(leadPhone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(`Hello ${waitingGuest.name}, please join our ${s.kind === 'voice' ? 'voice' : 'video'} call using this link: ${waitingGuest.link}`)}`}>
            <MessageCircle className="h-4 w-4" aria-hidden /> Send on WhatsApp
          </a>
          <Button variant="secondary" onClick={() => void copyLink()}>{copiedLink ? <Check className="h-4 w-4 text-ok" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copiedLink ? 'Copied' : 'Copy link'}</Button>
        </Card>
      )}
      {s?.status === 'ended' && s.outcome && s.outcome !== 'completed' && <Notice tone="warn">This session ended: {OUTCOME_TEXT[s.outcome].toLowerCase()}.</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="space-y-3 p-4">
          {!join && !error && <div className="grid place-items-center py-16"><Spinner label="Opening the session" /></div>}
          {join && !over && <VideoRoom join={join} renew={renew} report={report} onLeft={onLeft} onSnapshot={onSnapshot} label={`${join.kind === 'voice' ? 'Voice' : 'Video'} call`} />}
          {over && (
            <div className="space-y-3 py-8 text-center">
              <p className="text-sm text-muted">{ENDINGS[over]}</p>
              <div className="flex justify-center gap-2">
                {s?.status !== 'ended' && over !== 'removed' && <Button variant="secondary" onClick={() => void enter()}>Join again</Button>}
                {s?.canManage && s.status !== 'ended' && <Button variant="danger" onClick={() => void end()} loading={ending}>End for everyone</Button>}
                <Button variant="ghost" onClick={() => router.push('/communications')}>All calls</Button>
              </div>
            </div>
          )}
          {s?.canManage && s.status === 'open' && !over && (
            <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => void end()} loading={ending}>End for everyone</Button></div>
          )}
        </Card>
        {s && (
          <Card className="p-4">
            <PeoplePanel session={s} onChanged={reload} />
            <p className="mt-3 text-xs text-muted">Recording is not switched on for calls and meetings.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
