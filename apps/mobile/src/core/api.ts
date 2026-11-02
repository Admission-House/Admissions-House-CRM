import * as SecureStore from 'expo-secure-store';
import { config } from './config';

/**
 * The one place the app talks to the API. The access token lives in memory; the refresh token is
 * kept in the phone's secure storage (Keychain / Keystore). A 401 triggers one silent refresh and one
 * retry, and if that fails the app is told the session is over.
 */

export interface FieldError { field: string; message: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const BASE = `${config.apiUrl}/api/v1`;
const REFRESH_KEY = 'ah.refresh';
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSignedOut: (() => void) | null = null;

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const onSessionLost = (fn: () => void) => { onSignedOut = fn; };
export const storeRefreshToken = (t: string) => SecureStore.setItemAsync(REFRESH_KEY, t);
export const clearRefreshToken = () => SecureStore.deleteItemAsync(REFRESH_KEY);

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; fieldErrors?: FieldError[]; details?: Record<string, unknown> } };
    const e = body.error;
    return new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong', e?.fieldErrors, e?.details);
  } catch {
    return new ApiError(res.status, 'ERROR', 'Something went wrong. Please try again.');
  }
}

export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const token = await SecureStore.getItemAsync(REFRESH_KEY);
      if (!token) return false;
      const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
      if (!res.ok) {
        if (res.status === 401) await clearRefreshToken();
        return false;
      }
      const json = (await res.json()) as { accessToken: string; refreshToken?: string };
      accessToken = json.accessToken;
      if (json.refreshToken) await storeRefreshToken(json.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** A file upload. The phone sets the content type itself, with the part boundary. */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined | null>;
  anonymous?: boolean;
  signal?: AbortSignal;
}

function url(path: string, query?: RequestOptions['query']): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `${BASE}${path}${s ? `?${s}` : ''}`;
}

/** Sends the request with the access token, retries once after a silent refresh, and turns a failure into an ApiError. */
async function request(path: string, opts: RequestOptions): Promise<Response> {
  const send = () =>
    fetch(url(path, opts.query), {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: {
        ...(opts.body !== undefined && !opts.form && { 'content-type': 'application/json' }),
        ...(accessToken && !opts.anonymous && { authorization: `Bearer ${accessToken}` }),
      },
      body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });

  let res: Response;
  try {
    res = await send();
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your internet and try again.');
  }
  if (res.status === 401 && !opts.anonymous) {
    if (await refreshSession()) res = await send();
    if (res.status === 401) {
      accessToken = null;
      onSignedOut?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** For a file the API returns (a PDF): its bytes and the name the server gave it, if any. */
export async function apiFile(path: string, opts: RequestOptions = {}): Promise<{ bytes: ArrayBuffer; fileName: string | null }> {
  const res = await request(path, opts);
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? null;
  return { bytes: await res.arrayBuffer(), fileName };
}
