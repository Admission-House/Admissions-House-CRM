'use client';

import { Check, Copy, MessageCircle, Mic, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button, Field, Input, Notice, Select, Spinner } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, ApiError } from '@/lib/api';
import { OUTCOME_TEXT, PHASE_TEXT, type SessionView } from '@/lib/communications';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

interface Usage {
  usedStandardMinutes: number;
  limitStandardMinutes: number | null;
  videoMinutesLeft: number | null;
  voiceMinutesLeft: number | null;
}

/** Start a voice or video call with a lead, send the lead the link, and join, copy or end the sessions. */
export function VideoModal({ leadId, leadName, phone, onClose }: { leadId: string; leadName: string; phone: string; onClose: () => void }) {
  const router = useRouter();
  const sessions = useApi<SessionView[]>(`/leads/${leadId}/communications`);
  const usage = useApi<Usage>('/communications/usage');
  const [kind, setKind] = useState<'video' | 'voice'>('video');
  const [minutes, setMinutes] = useState('30');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { maxMinutes: Number(minutes), kind };
      if (when) body.scheduledFor = new Date(when).toISOString();
      const made = await api<SessionView>(`/leads/${leadId}/communications`, { method: 'POST', body });
      sessions.reload();
      usage.reload();
      setWhen('');
      setCopied(null);
      if (!when) router.push(`/video/${made.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function end(id: string) {
    setError(null);
    try {
      await api(`/communications/${id}/end`, { method: 'POST', body: {} });
      sessions.reload();
      usage.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the server.');
    }
  }

  async function copy(s: SessionView) {
    if (!s.guestUrl) return;
    try {
      await navigator.clipboard.writeText(s.guestUrl);
      setCopied(s.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not copy. Open the session and copy the link from there.');
    }
  }

  const share = (s: SessionView) =>
    `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hello ${leadName.split(' ')[0]}, please join our ${s.kind === 'voice' ? 'voice' : 'video'} session using this link: ${s.guestUrl}`)}`;

  const u = usage.data;
  const nearLimit = u?.limitStandardMinutes ? u.usedStandardMinutes >= u.limitStandardMinutes * 0.8 : false;

  // Drawn on the page itself: inside the lead header the frosted glass would make "fixed" relative to the header.
  return createPortal(
    <Modal title="Voice and video counselling" onClose={onClose} width="max-w-xl">
      <div className="space-y-5">
        <div role="radiogroup" aria-label="Kind of call" className="grid grid-cols-2 gap-2">
          {([['video', 'Video call', Video], ['voice', 'Voice call', Mic]] as const).map(([key, text, Icon]) => (
            <button key={key} type="button" role="radio" aria-checked={kind === key} onClick={() => setKind(key)}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition ${kind === key ? 'border-brand bg-mint text-brand' : 'border-line-strong bg-surface text-ink hover:bg-head'}`}>
              <Icon className="h-4 w-4" aria-hidden /> {text}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Length" htmlFor="vm" hint="The call ends by itself after this.">
            <Select id="vm" value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} minutes</option>)}
            </Select>
          </Field>
          <Field label="Planned time (optional)" htmlFor="vw" hint="Leave empty to start now.">
            <Input id="vw" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        </div>
        <Button onClick={() => void create()} loading={busy}>
          {kind === 'voice' ? <Mic className="h-4 w-4" aria-hidden /> : <Video className="h-4 w-4" aria-hidden />} {when ? 'Plan session and get link' : 'Start now'}
        </Button>
        {error && <Notice tone="bad">{error}</Notice>}
        {u && (
          <p className={`text-xs ${nearLimit ? 'text-warn' : 'text-muted'}`}>
            {u.limitStandardMinutes === null
              ? 'No monthly limit is set.'
              : `This month's free allowance has room for about ${(u.videoMinutesLeft ?? 0).toLocaleString('en-IN')} more minutes of video calls, or ${(u.voiceMinutesLeft ?? 0).toLocaleString('en-IN')} minutes of voice calls.`}
          </p>
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Sessions with this lead</h3>
          {sessions.loading && !sessions.data && <Spinner />}
          {sessions.data?.length === 0 && <p className="text-sm text-muted">No sessions yet.</p>}
          <ul className="divide-y divide-line rounded-lg border border-line">
            {sessions.data?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2">
                    <Badge tone={s.status === 'open' ? 'brand' : s.outcome === 'completed' ? 'ok' : 'neutral'}>{s.status === 'ended' && s.outcome ? OUTCOME_TEXT[s.outcome] : PHASE_TEXT[s.phase]}</Badge>
                    <span className="text-muted">{s.kind === 'voice' ? 'Voice' : 'Video'} · {s.maxMinutes} min</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{s.scheduledFor ? `For ${fmtDateTime(s.scheduledFor)}` : `Made ${fmtDateTime(s.createdAt)}`} · by {s.createdBy}</p>
                </div>
                {s.status === 'open' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" onClick={() => router.push(`/video/${s.id}`)}>Join</Button>
                    {s.guestUrl && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => void copy(s)}>{copied === s.id ? <Check className="h-3.5 w-3.5 text-ok" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />} Link</Button>
                        <a href={share(s)} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-ink hover:bg-head"><MessageCircle className="h-3.5 w-3.5 text-ok" aria-hidden /> WhatsApp</a>
                      </>
                    )}
                    {s.canManage && <Button size="sm" variant="ghost" onClick={() => void end(s.id)}>End</Button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
