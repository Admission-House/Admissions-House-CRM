'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, getAccessToken, refreshSession } from './api';
import { useAuth } from './auth';
import { changedTopics, nextWaitMs, type Pulse } from './pulse-rules';

/** What a hint can be about. `resync` means the connection was lost for a while, so ask for everything again. */
export type Topic = 'notification' | 'team' | 'lead' | 'call' | 'work' | 'admin' | 'resync';
type Listener = (topics: readonly string[]) => void;

interface Live {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
}

const Ctx = createContext<Live>({ connected: false, subscribe: () => () => undefined });

/**
 * Where the live connection goes. Behind the company's web address the API shares it, so the address is
 * the same page address with /api/v1/ws. `next dev` cannot pass a WebSocket through to the API, so on a
 * developer machine (the page on port 3000) the API on port 3001 is used directly. NEXT_PUBLIC_WS_URL
 * overrides both.
 */
function socketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location.port === '3000' ? `${location.hostname}:3001` : location.host;
  return `${scheme}//${host}/api/v1/ws`;
}

const KEEPALIVE_MS = 25_000;

/**
 * "ws": a WebSocket carries the hints (a server that can keep it open). "poll": a place that cannot (Vercel) asks one small
 * question now and then instead. Chosen when the web app is built (NEXT_PUBLIC_REALTIME=poll).
 */
export const POLLING = process.env.NEXT_PUBLIC_REALTIME === 'poll';

// How often the question is asked. Quiet and cheap by default: fast only while someone is ringing, slow when nobody is looking.
const POLL_ACTIVE_MS = Math.max(5, Number(process.env.NEXT_PUBLIC_POLL_SEC ?? 15) || 15) * 1000;
const POLL_QUIET_MS = 60_000; // tab hidden, or nobody has touched the screen for two minutes
const POLL_RINGING_MS = 3_000;
const POLL_MAX_BACKOFF_MS = 120_000;
const QUIET_AFTER_MS = 120_000;
const RESYNC_EVERY_MS = 300_000; // a safety net: now and then every screen looks again, in case a change was missed


/**
 * Keeps one connection to the server while someone is signed in. The server only says that something
 * changed ("a notification came", "the team changed"); the screens then ask the normal API for the new
 * numbers. If the connection fails, screens still refresh on their own timers, a little later.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    if (POLLING) return startPolling((topics) => listeners.current.forEach((l) => l(topics)), setConnected);
    let stopped = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let delay = 1_000;

    const emit = (topics: readonly string[]) => listeners.current.forEach((l) => l(topics));

    const schedule = (wait: number) => {
      if (stopped) return;
      retry = setTimeout(connect, wait);
    };

    function connect() {
      const token = getAccessToken();
      if (stopped || !token) return schedule(2_000);
      const ws = new WebSocket(socketUrl());
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (m: MessageEvent<string>) => {
        let msg: { type?: string; topics?: string[] };
        try {
          msg = JSON.parse(m.data) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          setConnected(true);
          delay = 1_000;
          keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), KEEPALIVE_MS);
          // Whatever changed before this connection was ready was missed (the screens loaded first), so every screen asks again.
          emit(['resync']);
        } else if (msg.type === 'event' && msg.topics) {
          emit(msg.topics);
        }
      };
      ws.onclose = (e) => {
        clearInterval(keepalive);
        setConnected(false);
        if (stopped) return;
        // The access token only lasts a few minutes: after "sign in again", get a new one and reconnect at once.
        if (e.code === 4401) void refreshSession().then((ok) => schedule(ok ? 300 : 5_000));
        else {
          schedule(delay + Math.random() * 500);
          delay = Math.min(delay * 2, 30_000);
        }
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(keepalive);
      socket?.close();
      setConnected(false);
    };
  }, [status]);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Asks the server what changed, and tells the screens which topics moved. One request for everything, never one
 * per screen. It slows down when the tab is hidden or untouched, speeds up while a call is ringing, backs off when
 * the server does not answer, and stops with the returned function.
 */
function startPolling(emit: (topics: readonly string[]) => void, setConnected: (on: boolean) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: Pulse | null = null;
  let failures = 0;
  let touched = Date.now();
  let lastResync = Date.now();

  const touch = () => { touched = Date.now(); };
  const wait = (ringing: boolean): number =>
    nextWaitMs({ activeMs: POLL_ACTIVE_MS, quietMs: POLL_QUIET_MS, ringingMs: POLL_RINGING_MS, maxBackoffMs: POLL_MAX_BACKOFF_MS }, { failures, ringing, hidden: document.hidden, untouchedMs: Date.now() - touched }, QUIET_AFTER_MS);
  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(() => void tick(), ms); };

  async function tick() {
    try {
      const now = await api<Pulse>('/realtime/pulse');
      failures = 0;
      setConnected(true);
      const resyncDue = Date.now() - lastResync > RESYNC_EVERY_MS;
      if (resyncDue) lastResync = Date.now();
      const changed = changedTopics(last, now, resyncDue);
      last = now;
      if (changed.length > 0) emit(changed);
      schedule(wait(now.ringing));
    } catch {
      failures += 1;
      setConnected(false);
      schedule(wait(false));
    }
  }

  const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
  const events = ['pointerdown', 'keydown', 'scroll'] as const;
  events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
  document.addEventListener('visibilitychange', visible);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    events.forEach((e) => window.removeEventListener(e, touch));
    document.removeEventListener('visibilitychange', visible);
    setConnected(false);
  };
}

/** Whether the live connection is up. Screens that refresh on a timer can slow it down while it is. */
export const useRealtimeStatus = (): boolean => useContext(Ctx).connected;

/**
 * Runs `onChange` when the server says one of these topics changed (or the connection was lost and came
 * back). It runs at most once every `minGapMs`, so a busy minute does not make a screen reload over and over.
 */
export function useRealtime(topics: readonly Topic[], onChange: () => void, minGapMs = 3_000): void {
  const { subscribe } = useContext(Ctx);
  const handler = useRef(onChange);
  useEffect(() => { handler.current = onChange; });
  const wanted = topics.join(',');

  useEffect(() => {
    if (!wanted) return;
    const mine = new Set(wanted.split(','));
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const run = () => { last = Date.now(); trailing = undefined; handler.current(); };
    const off = subscribe((got) => {
      if (!got.some((t) => t === 'resync' || mine.has(t))) return;
      const wait = last + minGapMs - Date.now();
      if (wait <= 0) run();
      else trailing ??= setTimeout(run, wait);
    });
    return () => { off(); clearTimeout(trailing); };
  }, [subscribe, wanted, minGapMs]);
}
