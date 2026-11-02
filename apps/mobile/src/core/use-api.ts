import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type RequestOptions } from './api';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Loads a path and keeps the answer. Pass null to wait (for example until a permission is known). */
export function useApi<T>(path: string | null, query?: RequestOptions['query']): ApiState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(query ?? {});
  const latest = useRef(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const run = ++latest.current;
    setLoading(true);
    api<T>(path, { query: JSON.parse(key) as RequestOptions['query'] })
      .then((d) => { if (run === latest.current) { setData(d); setError(undefined); } })
      .catch((e: unknown) => { if (run === latest.current) setError(e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Something went wrong')); })
      .finally(() => { if (run === latest.current) setLoading(false); });
  }, [path, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
