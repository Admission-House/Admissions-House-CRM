'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onSessionLost, refreshSession, setAccessToken } from './api';

export interface Me {
  user: { id: string; name: string; email: string; role: { key: string | null; dataScope: 'all' | 'team' | 'own' }; mustChangePassword: boolean };
  permissions: string[];
  company: { name: string; productName: string; contactEmail: string | null; brandColor: string | null; accentColor: string | null; hasLogo: boolean };
}

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  me: Me | null;
  can: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  login: (input: { tenant: string; email: string; password: string }) => Promise<{ mustChangePassword: boolean }>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    onSessionLost(() => {
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
        res = await attempt();
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
      await load();
      return { mustChangePassword: res.mustChangePassword };
    },
    [load],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
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
