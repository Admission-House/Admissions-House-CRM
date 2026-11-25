'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onSessionLost, refreshSession, setAccessToken } from './api';
import { homePath } from './start-page';

export interface Me {
  user: { id: string; name: string; email: string; role: { key: string | null; dataScope: 'all' | 'team' | 'own' }; mustChangePassword: boolean; mfaSetupRequired: boolean; startPage: string | null; avatarVersion: number | null };
  permissions: string[];
  company: { name: string; productName: string; contactEmail: string | null; brandColor: string | null; accentColor: string | null; hasLogo: boolean };
}

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  me: Me | null;
  can: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  /** With `remoteReason`, office staff outside the office ask for approval to sign in today (see the login page). */
  login: (input: { tenant: string; email: string; password: string; mfaCode?: string; remoteReason?: string }) => Promise<{ mustChangePassword: boolean; home: string }>;
  logout: () => Promise<void>;
  reload: () => Promise<Me>;
}

const Ctx = createContext<AuthState | null>(null);

/** The place name and GPS position the office check needs. Resolves to nothing if the person says no. */
function position(): Promise<{ lat: number; lng: number; accuracy: number } | undefined> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(undefined);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    ),
  );
}

/** The marker the web server reads to skip the "Loading, then back to /login" step for someone who is not signed in. It holds nothing secret. */
function markSignedIn(on: boolean, startPage?: string | null): void {
  if (typeof document === 'undefined') return;
  const secure = location.protocol === 'https:' ? '; secure' : '';
  const set = (name: string, value: string | null) => {
    document.cookie = value === null ? `${name}=; path=/; max-age=0; samesite=lax` : `${name}=${value}; path=/; max-age=${7 * 24 * 3600}; samesite=lax${secure}`;
  };
  set('ah_in', on ? '1' : null);
  // The page they chose to open first. Only a hint for the web server; the app still checks what they may see.
  set('ah_home', on && startPage ? startPage : null);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    const fresh = await api<Me>('/auth/me');
    setMe(fresh);
    setStatus('authenticated');
    markSignedIn(true, fresh.user.startPage);
    return fresh;
  }, []);

  useEffect(() => {
    onSessionLost(() => {
      markSignedIn(false);
      setMe(null);
      setStatus('anonymous');
    });
    (async () => {
      if (await refreshSession()) {
        try {
          await load();
          return;
        } catch {
          /* fall through to anonymous */
        }
      }
      markSignedIn(false);
      setStatus('anonymous');
    })();
  }, [load]);

  const login: AuthState['login'] = useCallback(
    async (input) => {
      const attempt = (location?: { lat: number; lng: number; accuracy: number }) =>
        api<{ accessToken: string; mustChangePassword: boolean }>('/auth/login', {
          method: 'POST', anonymous: true, body: { ...input, clientType: 'web', ...(location && { location }) },
        });
      let res;
      try {
        if (input.remoteReason) {
          // A request for approval shows the approvers where the person is: ask for the position first, and say so if there is none.
          const location = await position();
          res = await api<{ accessToken: string; mustChangePassword: boolean }>('/auth/login', {
            method: 'POST', anonymous: true, body: { ...input, clientType: 'web', ...(location ? { location } : { locationUnavailable: true }) },
          });
        } else {
          res = await attempt();
        }
      } catch (e) {
        // Office staff must also prove where they are. Ask the browser for the position only then, so
        // everyone else is not asked.
        if (e instanceof ApiError && e.code === 'OUTSIDE_OFFICE' && e.details?.reason === 'gps_missing') {
          const location = await position();
          if (!location) throw e;
          res = await attempt(location);
        } else {
          throw e;
        }
      }
      setAccessToken(res.accessToken);
      const fresh = await load();
      return { mustChangePassword: res.mustChangePassword, home: homePath(fresh.user.startPage) };
    },
    [load],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    markSignedIn(false);
    setAccessToken(null);
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthState>(() => {
    const set = new Set(me?.permissions ?? []);
    return {
      status, me, login, logout, reload: load,
      can: (...p) => p.every((x) => set.has(x)),
      canAny: (...p) => p.some((x) => set.has(x)),
    };
  }, [status, me, login, logout, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
