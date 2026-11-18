'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type RequestOptions } from './api';
import { topicsForPath } from './pulse-rules';
import { useRealtime, type Topic } from './realtime';

export interface Loaded<T> {
  /** The last answer. It stays while a newer one is loading, so screens do not flash empty. */
  data: T | null;
  error: ApiError | null;
  /** True until the answer for the current path and query has arrived. */
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: ApiError | null;
}

/**
 * Loads one API resource and loads it again when the path or query changes. Pass null to wait. It also asks again,
 * without any flicker, when the server says something it depends on changed (another person edited a lead, a break
 * started ...), so no screen needs a manual refresh. `live: false` turns that off.
 */
export function useApi<T>(path: string | null, query?: RequestOptions['query'], options?: { live?: boolean }): Loaded<T> {
  const [tick, setTick] = useState(0);
  const [quiet, setQuiet] = useState(0);
  const silent = useRef(false);
  const topics = (options?.live === false ? [] : topicsForPath(path)) as Topic[];
  useRealtime(topics, () => { silent.current = true; setQuiet((n) => n + 1); }, 5_000);
  const [settled, setSettled] = useState<Settled<T>>({ key: '', data: null, error: null });
  const queryText = JSON.stringify(query ?? {});
  const key = `${path}|${queryText}|${tick}`;

  useEffect(() => {
    if (path === null) return;
    const quietly = silent.current;
    silent.current = false;
    const ctl = new AbortController();
    api<T>(path, { query: JSON.parse(queryText) as RequestOptions['query'], signal: ctl.signal })
      .then((data) => setSettled({ key, data, error: null }))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (quietly) return; // a refresh nobody asked for must not replace what is on screen with an error
        const error = e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
        setSettled((prev) => ({ key, data: prev.data, error }));
      });
    return () => ctl.abort();
  }, [path, queryText, key, quiet]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: settled.data, error: settled.key === key ? settled.error : null, loading: path !== null && settled.key !== key, reload };
}
