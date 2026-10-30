'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type RequestOptions } from './api';

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

/** Loads one API resource and loads it again when the path or query changes. Pass null to wait. */
export function useApi<T>(path: string | null, query?: RequestOptions['query']): Loaded<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>({ key: '', data: null, error: null });
  const queryText = JSON.stringify(query ?? {});
  const key = `${path}|${queryText}|${tick}`;

  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    api<T>(path, { query: JSON.parse(queryText) as RequestOptions['query'], signal: ctl.signal })
      .then((data) => setSettled({ key, data, error: null }))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const error = e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
        setSettled((prev) => ({ key, data: prev.data, error }));
      });
    return () => ctl.abort();
  }, [path, queryText, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: settled.data, error: settled.key === key ? settled.error : null, loading: path !== null && settled.key !== key, reload };
}
