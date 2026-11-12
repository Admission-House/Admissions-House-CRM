'use client';

import type { IAgoraRTCClient, IAgoraRTCRemoteUser, ICameraVideoTrack, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng';
import { Mic, MicOff, PhoneOff, UserRound, Video, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Notice, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import type { LeaveReason, PresenceEvent, RtcJoin, Snapshot } from '@/lib/communications';

export type { RtcJoin } from '@/lib/communications';

type Phase = 'starting' | 'live' | 'left' | 'failed';

/** How often the screen tells the server it is still here. The server treats 45 seconds of silence as gone. */
const PING_MS = 12_000;

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Words for what went wrong with the camera or microphone, instead of the browser's own. */
function deviceProblem(e: unknown, voice: boolean): string {
  const name = (e as { name?: string; code?: string })?.name ?? (e as { code?: string })?.code ?? '';
  const device = voice ? 'microphone' : 'camera or microphone';
  if (/NotAllowed|PERMISSION_DENIED/i.test(name)) return `The ${device} is blocked. Allow it in the browser (the lock icon beside the address) and try again.`;
  if (/NotFound|DEVICES_NOT_FOUND/i.test(name)) return `No ${device} was found on this device.`;
  if (/NotReadable|Busy/i.test(name)) return `The ${device} is being used by another program. Close it and try again.`;
  return `Could not start the call. Check your ${device} and internet, then try again.`;
}

/** One other person in the call: their picture, or a plain tile when they have no video (a voice call). */
function RemoteTile({ user, version, voice }: { user: IAgoraRTCRemoteUser; version: number; voice: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const track = user.videoTrack;
    if (!voice && track && box.current) track.play(box.current);
    return () => track?.stop();
  }, [user, version, voice]);
  return (
    <div ref={box} className="relative grid h-full min-h-0 w-full place-items-center overflow-hidden rounded-lg bg-[#10302e]">
      {(voice || !user.hasVideo) && <span className="grid h-16 w-16 place-items-center rounded-full bg-white/15 text-white"><UserRound className="h-8 w-8" aria-hidden /></span>}
    </div>
  );
}

interface RoomProps {
  join: RtcJoin;
  /** Asks the server for a fresh token, a little before the current one ends. A refusal means the session is over for this person. */
  renew: () => Promise<RtcJoin>;
  /** Tells the server this screen is connected, still here, or gone. The answer says whether the session is still on. */
  report: (event: PresenceEvent) => Promise<Snapshot | null>;
  onLeft: (reason: LeaveReason) => void;
  /** Gets every answer to `report`, so the page around the call can show who is in it. */
  onSnapshot?: (s: Snapshot) => void;
  label?: string;
}

/**
 * One call: voice or video, between two people or a meeting of several. It joins the channel it is given,
 * shows everyone else, and gives mute, camera (video calls) and leave. It keeps its token fresh, tells the
 * server it is there, and leaves by itself when the time is up, the session is ended, or the person is
 * taken out. The server enforces all three; this screen only follows.
 */
export function VideoRoom({ join, renew, report, onLeft, onSnapshot, label }: RoomProps) {
  const voice = join.kind === 'voice';
  const local = useRef<HTMLDivElement>(null);
  const client = useRef<IAgoraRTCClient | null>(null);
  const tracks = useRef<{ mic: IMicrophoneAudioTrack | null; cam: ICameraVideoTrack | null }>({ mic: null, cam: null });
  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [remotes, setRemotes] = useState<IAgoraRTCRemoteUser[]>([]);
  const [version, setVersion] = useState(0);
  const [left, setLeft] = useState(join.secondsLeft);
  const finished = useRef(false);
  /** True once the server has been told this screen is connected, and until it is told that it left. */
  const reported = useRef(false);

  // The latest callbacks, so the effect below never restarts (and so never rejoins) when the parent re-renders.
  const latest = useRef({ renew, report, onLeft, onSnapshot });
  useEffect(() => {
    latest.current = { renew, report, onLeft, onSnapshot };
  }, [renew, report, onLeft, onSnapshot]);

  const leave = useCallback(async (reason: LeaveReason) => {
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
    // Best effort: if this does not arrive the server notices the silence.
    if (reported.current) void latest.current.report('left').catch(() => undefined);
    reported.current = false;
    setPhase('left');
    latest.current.onLeft(reason);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pinger: ReturnType<typeof setInterval> | undefined;
    finished.current = false;

    const heard = (s: Snapshot | null) => {
      if (!s) return;
      latest.current.onSnapshot?.(s);
      setLeft(s.secondsLeft);
      if (s.removed) void leave('removed');
      else if (s.status === 'ended') void leave('ended');
    };

    async function start() {
      try {
        // Loaded only here: the SDK needs the browser and is large, so it is not part of the first page load.
        const AgoraRTC = (await import('agora-rtc-sdk-ng')).default;
        AgoraRTC.setLogLevel(3);
        const c = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        client.current = c;

        const refresh = () => {
          setRemotes([...c.remoteUsers]);
          setVersion((v) => v + 1);
        };
        const receive = async (user: IAgoraRTCRemoteUser, kind: 'audio' | 'video') => {
          try {
            await c.subscribe(user, kind);
            if (kind === 'audio') user.audioTrack?.play();
            refresh();
          } catch (err) {
            console.error('Could not receive the other person media', kind, err);
          }
        };
        c.on('user-published', (user, kind) => {
          if (kind === 'audio' || kind === 'video') void receive(user, kind);
        });
        c.on('user-unpublished', refresh);
        c.on('user-joined', refresh);
        c.on('user-left', refresh);
        // A little before the token ends, ask for a new one. If the server says no, the call is over for this person.
        c.on('token-privilege-will-expire', () => {
          latest.current.renew().then((fresh) => c.renewToken(fresh.token)).catch((e: unknown) => {
            if (e instanceof ApiError && e.code === 'REMOVED') void leave('removed');
            else if (e instanceof ApiError && (e.code === 'SESSION_ENDED' || e.code === 'NOT_FOUND')) void leave('ended');
            else void leave('time');
          });
        });
        c.on('token-privilege-did-expire', () => void leave('time'));
        c.on('connection-state-change', (now, before, reason) => console.info('call connection', before, '->', now, reason ?? ''));
        c.on('exception', (e) => console.warn('call exception', e.code, e.msg));

        // Voice: the microphone only. Video: 480p keeps the picture clear and the minutes in the cheapest video class.
        const mic = await AgoraRTC.createMicrophoneAudioTrack();
        const cam = voice ? null : await AgoraRTC.createCameraVideoTrack({ encoderConfig: '480p_1' }).catch((e: unknown) => {
          mic.close();
          throw e;
        });
        if (cancelled) {
          mic.close();
          cam?.close();
          return;
        }
        tracks.current = { mic, cam };
        if (cam && local.current) cam.play(local.current);
        await c.join(join.appId, join.channel, join.token, join.uid);
        if (cancelled) return;
        await c.publish(cam ? [mic, cam] : [mic]);
        for (const user of c.remoteUsers) {
          if (user.hasAudio) await receive(user, 'audio');
          if (user.hasVideo) await receive(user, 'video');
        }
        refresh();
        setPhase('live');
        reported.current = true;
        heard(await latest.current.report('joined').catch(() => null));
        pinger = setInterval(() => void latest.current.report('ping').then(heard).catch(() => undefined), PING_MS);
      } catch (e) {
        if (cancelled) return;
        setProblem(deviceProblem(e, voice));
        setPhase('failed');
      }
    }
    void start();

    return () => {
      cancelled = true;
      if (pinger) clearInterval(pinger);
      // The page was closed or left by navigating: say so now rather than leaving the others to wait for the silence to be noticed.
      if (reported.current && !finished.current) void latest.current.report('left').catch(() => undefined);
      reported.current = false;
      tracks.current.mic?.close();
      tracks.current.cam?.close();
      tracks.current = { mic: null, cam: null };
      void client.current?.leave().catch(() => undefined);
      client.current = null;
    };
  }, [join, voice, leave]);

  // The time left, counted down on screen; the server's answer corrects it. At zero the call is left.
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

  const grid = remotes.length <= 1 ? 'grid-cols-1' : remotes.length <= 4 ? 'grid-cols-2' : 'grid-cols-3';
  return (
    <div className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[#0b1f1e] p-2" aria-label={label ?? (voice ? 'Voice call' : 'Video call')}>
        {remotes.length > 0 && (
          <div className={`grid h-full w-full gap-2 ${grid}`}>
            {remotes.map((u) => <RemoteTile key={String(u.uid)} user={u} version={version} voice={voice} />)}
          </div>
        )}
        {phase === 'starting' && <div className="absolute inset-0 grid place-items-center text-white"><Spinner label="Connecting" /></div>}
        {phase === 'live' && remotes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-white/85">Waiting for the other person to join…</div>
        )}
        {voice ? (
          phase === 'live' && <div className="absolute bottom-3 right-3 rounded-md bg-black/55 px-2 py-1 text-xs text-white">Voice · {remotes.length + 1} {remotes.length === 0 ? 'person' : 'people'}</div>
        ) : (
          <div ref={local} className="absolute bottom-3 right-3 h-28 w-40 overflow-hidden rounded-lg border border-white/30 bg-black/60 shadow-lg" />
        )}
        {phase === 'live' && (
          <div className="absolute left-3 top-3 rounded-md bg-black/55 px-2 py-1 text-xs tabular-nums text-white" role="timer" aria-label="Time left">{clock(left)} left</div>
        )}
      </div>
      <div className="flex items-center justify-center gap-3">
        <Button variant="secondary" onClick={() => void toggleMic()} disabled={phase !== 'live'} aria-pressed={!micOn} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>
          {micOn ? <Mic className="h-4 w-4" aria-hidden /> : <MicOff className="h-4 w-4 text-bad" aria-hidden />} {micOn ? 'Mute' : 'Unmute'}
        </Button>
        {!voice && (
          <Button variant="secondary" onClick={() => void toggleCam()} disabled={phase !== 'live'} aria-pressed={!camOn} aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}>
            {camOn ? <Video className="h-4 w-4" aria-hidden /> : <VideoOff className="h-4 w-4 text-bad" aria-hidden />} {camOn ? 'Camera' : 'Camera off'}
          </Button>
        )}
        <Button variant="danger" onClick={() => void leave('left')} disabled={phase === 'left'}>
          <PhoneOff className="h-4 w-4" aria-hidden /> Leave
        </Button>
      </div>
    </div>
  );
}
