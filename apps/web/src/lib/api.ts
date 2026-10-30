/**
 * The one place the browser talks to the API. The access token lives only in memory (never in
 * storage a script could read); the refresh token is an httpOnly cookie the browser sends by itself.
 * A 401 triggers one silent refresh and one retry.
 */

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
    readonly details?: Record<string, unknown>,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

const BASE = '/api/v1';
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;
export const onSessionLost = (fn: () => void) => {
  onSignedOut = fn;
};

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; fieldErrors?: FieldError[]; details?: Record<string, unknown>; requestId?: string } };
    const e = body.error;
    return new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong', e?.fieldErrors, e?.details, e?.requestId);
  } catch {
    return new ApiError(res.status, 'ERROR', 'Something went wrong. Please try again.');
  }
}

/** Gets a new access token with the refresh cookie. Several callers at once share one request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) return false;
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Do not try to refresh on 401 (used by sign-in itself). */
  anonymous?: boolean;
  signal?: AbortSignal;
}

function url(path: string, query?: RequestOptions['query']): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `${BASE}${path}${s ? `?${s}` : ''}`;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const send = () =>
    fetch(url(path, opts.query), {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        ...(accessToken && !opts.anonymous && { authorization: `Bearer ${accessToken}` }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

  let res = await send();
  if (res.status === 401 && !opts.anonymous) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) {
      accessToken = null;
      onSignedOut?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** For files (uploads and downloads) that are not JSON. */
export async function apiRaw(path: string, init: { method?: string; body?: BodyInit; query?: RequestOptions['query'] } = {}): Promise<Response> {
  const send = () =>
    fetch(url(path, init.query), { method: init.method ?? 'GET', credentials: 'same-origin', body: init.body, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  if (!res.ok) throw await parseError(res);
  return res;
}

/** Saves a file the API returned (a CSV, Excel sheet or PDF) through the browser's download. */
export async function download(path: string, query?: RequestOptions['query']): Promise<void> {
  const res = await apiRaw(path, { query });
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
