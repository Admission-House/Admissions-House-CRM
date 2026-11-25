'use client';

import { Download, Play } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Notice, Spinner } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { RECORDING_TEXT, type RecordingItem, type RecordingState } from '@/lib/communications';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';

const tone = (s: RecordingState) =>
  s === 'available' ? 'ok' : s === 'failed' ? 'bad' : s === 'recording' ? 'brand' : 'neutral';
const size = (n: number | null) =>
  n === null
    ? ''
    : n > 1_048_576
      ? `${(n / 1_048_576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

/** The recordings of one session. A link is asked for only when someone presses play or download, and lasts a few minutes. */
export function RecordingsPanel({
  sessionId,
  kind,
}: {
  sessionId: string;
  kind: 'voice' | 'video';
}) {
  const list = useApi<{ status: RecordingState; recordings: RecordingItem[] }>(
    `/communications/${sessionId}/recordings`,
  );
  const [playing, setPlaying] = useState<{ fileId: string; url: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function link(fileId: string, purpose: 'play' | 'download') {
    setBusy(`${fileId}${purpose}`);
    setError(null);
    try {
      const { url } = await api<{ url: string; expiresAt: string }>(
        `/communications/${sessionId}/recordings/files/${fileId}/link`,
        { method: 'POST', body: { purpose } },
      );
      if (purpose === 'play') setPlaying({ fileId, url });
      else window.location.assign(url);
    } catch (e) {
      setError(errorText(e, 'Cannot reach the server.'));
    } finally {
      setBusy(null);
    }
  }

  if (list.loading && !list.data) return <Spinner />;
  const recordings = list.data?.recordings ?? [];
  if (recordings.length === 0) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-ink">Recording</h3>
      {error && <Notice tone="bad">{error}</Notice>}
      {recordings.map((r, n) => (
        <div key={r.id} className="space-y-2 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-ink">
              {recordings.length > 1 ? `Part ${n + 1}` : 'Recording'}
            </span>
            <Badge tone={tone(r.status)}>{RECORDING_TEXT[r.status]}</Badge>
            {r.expiresAt && r.status === 'available' && (
              <span className="text-xs text-muted">Kept until {fmtDateTime(r.expiresAt)}</span>
            )}
          </div>
          {r.status === 'failed' && (
            <p className="text-xs text-bad">
              {r.failureReason ?? 'The recording could not be made.'}
            </p>
          )}
          {(r.status === 'processing' || r.status === 'stopping') && (
            <p className="text-xs text-muted">
              The recording is being saved. It appears here when it is ready.
            </p>
          )}
          {r.status === 'expired' && (
            <p className="text-xs text-muted">
              This recording was removed after the retention period.
            </p>
          )}
          {r.files
            .filter((f) => f.playable)
            .map((f) => (
              <div key={f.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">
                    {f.kind === 'audio' || kind === 'voice' ? 'Sound' : 'Sound and picture'} ·{' '}
                    {f.format.toUpperCase()} {size(f.sizeBytes)}
                  </span>
                  {r.canPlay && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void link(f.id, 'play')}
                      loading={busy === `${f.id}play`}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden /> Play
                    </Button>
                  )}
                  {r.canDownload && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void link(f.id, 'download')}
                      loading={busy === `${f.id}download`}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden /> Download
                    </Button>
                  )}
                </div>
                {playing?.fileId === f.id &&
                  (kind === 'voice' || f.kind === 'audio' ? (
                    <audio
                      controls
                      autoPlay
                      src={playing.url}
                      className="w-full"
                      onError={() => setError('The link has expired. Press Play again.')}
                    />
                  ) : (
                    <video
                      controls
                      autoPlay
                      src={playing.url}
                      className="max-h-80 w-full rounded-lg bg-black"
                      onError={() => setError('The link has expired. Press Play again.')}
                    />
                  ))}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
