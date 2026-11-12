'use client';

import { ArrowLeft, Check, Copy } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Notice, Spinner } from '@/components/ui';
import { VideoRoom, type RtcJoin } from '@/components/video/video-room';
import { api, ApiError } from '@/lib/api';

type StaffJoin = RtcJoin & { guestUrl: string };

/** The counsellor's side of a video session. */
export default function VideoSessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [join, setJoin] = useState<StaffJoin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(false);
  const [ending, setEnding] = useState(false);
  const asked = useRef(false);

  const enter = useCallback(async () => {
    setError(null);
    try {
      setJoin(await api<StaffJoin>(`/video-sessions/${id}/join`, { method: 'POST', body: {} }));
      setDone(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    }
  }, [id]);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void enter();
  }, [enter]);

  const onLeft = useCallback(() => {
    setDone(true);
  }, []);

  async function copy() {
    if (!join) return;
    try {
      await navigator.clipboard.writeText(join.guestUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  }

  async function endForEveryone() {
    setEnding(true);
    try {
      await api(`/video-sessions/${id}/end`, { method: 'POST', body: {} });
      router.back();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
      setEnding(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <button type="button" onClick={() => router.back()} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to the lead</button>
      {error && <Notice tone="bad">{error}</Notice>}
      {!join && !error && <div className="grid place-items-center py-16"><Spinner label="Opening the session" /></div>}
      {join && (
        <Card className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Link for the student:</span>
            <code className="min-w-0 flex-1 truncate rounded bg-head px-2 py-1 text-xs">{join.guestUrl}</code>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>{copied ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />} {copied ? 'Copied' : 'Copy'}</Button>
          </div>
          {done ? (
            <div className="space-y-3 py-6 text-center">
              <p className="text-sm text-muted">You have left the call.</p>
              <div className="flex justify-center gap-2">
                <Button variant="secondary" onClick={() => void enter()}>Join again</Button>
                <Button variant="danger" onClick={() => void endForEveryone()} loading={ending}>End session for everyone</Button>
              </div>
            </div>
          ) : (
            <VideoRoom join={join} onLeft={onLeft} label="Video call with the student" />
          )}
        </Card>
      )}
    </div>
  );
}
