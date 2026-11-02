import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { Me } from '@/models/types';
import { api, ApiError, clearRefreshToken, onSessionLost, refreshSession, setAccessToken, storeRefreshToken } from './api';
import { config } from './config';
import { disablePush } from './push';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface Session {
  status: Status;
  me: Me | null;
  can: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  login: (input: { tenant: string; email: string; password: string }) => Promise<{ mustChangePassword: boolean }>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const LAST_TENANT = 'ah.tenant';

export const lastTenant = async (): Promise<string> => config.companySlug || (await SecureStore.getItemAsync(LAST_TENANT)) || '';

/** A stable id for this phone, so the company can approve or block devices. */
async function deviceFingerprint(): Promise<string> {
  const id = Platform.OS === 'android' ? Application.getAndroidId() : await Application.getIosIdForVendorAsync();
  return (id && id.length >= 8 ? id : `unknown-${Application.applicationId ?? 'app'}-device`).slice(0, 128);
}

/**
 * Whether the phone looks rooted (Android) or jailbroken (iOS). The check is the phone library's own
 * and is not fully reliable. If it cannot run, the phone is treated as normal rather than blocked.
 */
async function isRooted(): Promise<boolean> {
  try {
    return await Device.isRootedExperimentalAsync();
  } catch {
    return false;
  }
}

/** The phone's position for the office check. Resolves to nothing if the person says no. */
async function position(): Promise<{ lat: number; lng: number; accuracy: number; mocked?: boolean } | undefined> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') return undefined;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 100_000, mocked: p.mocked ?? false };
  } catch {
    return undefined;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    setMe(await api<Me>('/auth/me'));
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    onSessionLost(() => { setMe(null); setStatus('anonymous'); });
    void (async () => {
      if (await refreshSession()) {
        try { await load(); return; } catch { /* fall through to anonymous */ }
      }
      setStatus('anonymous');
    })();
  }, [load]);

  const login: Session['login'] = useCallback(async (input) => {
    const device = { fingerprint: await deviceFingerprint(), platform: Platform.OS === 'ios' ? ('ios' as const) : ('android' as const), label: Application.applicationName ?? undefined, rooted: await isRooted() };
    const attempt = (location?: Awaited<ReturnType<typeof position>>) =>
      api<{ accessToken: string; refreshToken: string; mustChangePassword: boolean }>('/auth/login', {
        method: 'POST', anonymous: true, body: { ...input, clientType: 'mobile', device, ...(location && { location }) },
      });
    let res;
    try {
      res = await attempt();
    } catch (e) {
      // Office staff must also prove where they are. Ask for the position only then.
      if (e instanceof ApiError && e.code === 'OUTSIDE_OFFICE' && e.details?.reason === 'gps_missing') {
        const location = await position();
        if (!location) throw new ApiError(e.status, e.code, 'Allow location access so the app can check that you are at the office, then sign in again.');
        res = await attempt(location);
      } else {
        throw e;
      }
    }
    setAccessToken(res.accessToken);
    await storeRefreshToken(res.refreshToken);
    await SecureStore.setItemAsync(LAST_TENANT, input.tenant);
    await load();
    return { mustChangePassword: res.mustChangePassword };
  }, [load]);

  const logout = useCallback(async () => {
    await disablePush(); // while the sign-in still works, so this phone stops getting this person's alerts
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    setAccessToken(null);
    await clearRefreshToken();
    setMe(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<Session>(() => {
    const set = new Set(me?.permissions ?? []);
    return { status, me, login, logout, reload: load, can: (...p) => p.every((x) => set.has(x)), canAny: (...p) => p.some((x) => set.has(x)) };
  }, [status, me, login, logout, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
