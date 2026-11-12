'use client';

import type { IAgoraRTCClient, IAgoraRTCRemoteUser, ICameraVideoTrack, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';
import { Mic, MicOff, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice, Spinner } from '@/components/ui';

export interface RtcJoin {
  appId: string;
  channel: string;
  token: string;
  uid: number;
  /** Seconds of call time left. The call ends by itself when this runs out. */
  secondsLeft: number;
}

type Phase = 'starting' | 'live' | 'left' | 'failed';

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Words for what went wrong with the camera or microphone, instead of the browser's own. */
function deviceProblem(e: unknown): string {
  const name = (e as { name?: string; code?: string })?.name ?? (e as { code?: string })?.code ?? '';
  if (/NotAllowed|PERMISSION_DENIED/i.test(name)) return 'The camera or microphone is blocked. Allow them in the browser (the lock icon beside the address) and try again.';
  if (/NotFound|DEVICES_NOT_FOUND/i.test(name)) return 'No camera or microphone was found on this device.';
  if (/NotReadable|Busy/i.test(name)) return 'The camera or microphone is being used by another program. Close it and try again.';
  return 'Could not start the video. Check your camera, microphone and internet, then try again.';
}

/**
 * One video call. It joins the channel it is given, shows the other person large and you small, and
 * gives mute, camera and leave. The call ends by itself when the session's time is up, which is also
 * when the join token stops working, so the limit does not depend on this timer alone.
 */
export function VideoRoom({ join, onLeft, label }: { join: RtcJoin; onLeft: (reason: 'left' | 'time') => void; label?: string }) {
  const remote = useRef<HTMLDivElement>(null);
  const local = useRef<HTMLDivElement>(null);
  const client = useRef<IAgoraRTCClient | null>(null);
  const tracks = useRef<{ mic: IMicrophoneAudioTrack | null; cam: ICameraVideoTrack | null }>({ mic: null, cam: null });
  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [someoneThere, setSomeoneThere] = useState(false);
  const [left, setLeft] = useState(join.secondsLeft);
  const finished = useRef(false);

  const leave = useCallback(
    async (reason: 'left' | 'time') => {
      if (finished.current) return;
      finished.current = true;
      tracks.current.mic?.close();
      tracks.current.cam?.close();
      tracks.current = { mic: null, cam: null };
      try {
        await client.current?.leave();
      } catch {
        // Already disconnected.
      }
      setPhase('left');
      onLeft(reason);
    },
    [onLeft],
  );

  // The effect below must not restart (and so rejoin) when the parent re-renders with a new callback.
  const leaveRef = useRef(leave);
  useEffect(() => {
    leaveRef.current = leave;
  }, [leave]);

  useEffect(() => {
    let cancelled = false;
    finished.current = false;

    async function start() {
      try {
        // Loaded only here: the SDK needs the browser and is large, so it is not part of the first page load.
        const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
        AgoraRTC.setLogLevel(3);
        const c = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        client.current = c;

        const show = async (user: IAgoraRTCRemoteUser, kind: 'audio' | 'video') => {
          try {
            await c.subscribe(user, kind);
            if (kind === 'video' && remote.current) user.videoTrack?.play(remote.current);
            if (kind === 'audio') user.audioTrack?.play();
            setSomeoneThere(true);
          } catch (err) {
            console.error('Could not receive the other person media', kind, err);
          }
        };
        c.on('user-joined', () => setSomeoneThere(true));
        c.on('connection-state-change', (now, before, reason) => console.info('video connection', before, '->', now, reason ?? ''));
        c.on('exception', (e) => console.warn('video exception', e.code, e.msg));
        c.on('user-published', (user, kind) => {
          if (kind === 'audio' || kind === 'video') void show(user, kind);
        });
        c.on('user-left', () => setSomeoneThere(c.remoteUsers.length > 0));
        c.on('token-privilege-did-expire', () => void leaveRef.current('time'));

        // 480p keeps the picture clear and the minutes in the cheapest video class.
        const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks({}, { encoderConfig: '480p_1' });
        if (cancelled) {
          mic.close();
          cam.close();
          return;
        }
        tracks.current = { mic, cam };
        if (local.current) cam.play(local.current);
        await c.join(join.appId, join.channel, join.token, join.uid);
        if (cancelled) return;
        await c.publish([mic, cam]);
        for (const user of c.remoteUsers) {
          if (user.hasVideo) await show(user, 'video');
          if (user.hasAudio) await show(user, 'audio');
        }
        setPhase('live');
      } catch (e) {
        if (cancelled) return;
        setProblem(deviceProblem(e));
        setPhase('failed');
      }
    }
    void start();

    return () => {
      cancelled = true;
      tracks.current.mic?.close();
      tracks.current.cam?.close();
      tracks.current = { mic: null, cam: null };
      void client.current?.leave().catch(() => undefined);
      client.current = null;
    };
  }, [join]);

  // The agreed time, counted down on screen; at zero the call is left.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (phase === 'live' && left === 0) void leave('time');
  }, [phase, left, leave]);

  async function toggleMic() {
    const t = tracks.current.mic;
    if (!t) return;
    await t.setEnabled(!micOn);
    setMicOn(!micOn);
  }
  async function toggleCam() {
    const t = tracks.current.cam;
    if (!t) return;
    await t.setEnabled(!camOn);
    setCamOn(!camOn);
  }

  if (phase === 'failed') return <Notice tone="bad">{problem}</Notice>;

  return (
    <div className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#0b1f1e]" aria-label={label ?? 'Video call'}>
        <div ref={remote} className="h-full w-full" />
        {phase === 'starting' && <div className="absolute inset-0 grid place-items-center text-white"><Spinner label="Connecting" /></div>}
        {phase === 'live' && !someoneThere && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/85">Waiting for the other person to join…</div>
        )}
        <div ref={local} className="absolute bottom-3 right-3 h-28 w-40 overflow-hidden rounded-lg border border-white/30 bg-black/60 shadow-lg" />
        {phase === 'live' && (
          <div className="absolute left-3 top-3 rounded-md bg-black/55 px-2 py-1 text-xs tabular-nums text-white" role="timer" aria-label="Time left">{clock(left)} left</div>
        )}
      </div>
      <div className="flex items-center justify-center gap-3">
        <Button variant="secondary" onClick={() => void toggleMic()} disabled={phase !== 'live'} aria-pressed={!micOn} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>
          {micOn ? <Mic className="h-4 w-4" aria-hidden /> : <MicOff className="h-4 w-4 text-bad" aria-hidden />} {micOn ? 'Mute' : 'Unmute'}
        </Button>
        <Button variant="secondary" onClick={() => void toggleCam()} disabled={phase !== 'live'} aria-pressed={!camOn} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}>
          {camOn ? <Video className="h-4 w-4" aria-hidden /> : <VideoOff className="h-4 w-4 text-bad" aria-hidden />} {camOn ? 'Camera' : 'Camera off'}
        </Button>
        <Button variant="danger" onClick={() => void leave('left')} disabled={phase === 'left'}>
          <PhoneOff className="h-4 w-4" aria-hidden /> Leave
        </Button>
      </div>
    </div>
  );
}
