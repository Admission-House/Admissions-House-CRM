import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Phone alerts. The app asks the phone for permission and for its push token, and gives the token to
 * the CRM so it can send alerts for this person. Nothing here is specific to one company.
 */

const TOKEN_KEY = 'ah.pushToken';

/** `ready` alerts are on. `denied` the person said no in the phone's settings. `not_a_phone` an emulator. `not_set_up` this build has no push project yet. */
export type PushStatus = 'ready' | 'denied' | 'not_a_phone' | 'not_set_up';

/** While the app is open an alert still shows as a banner and plays a sound. */
export function showAlertsWhileOpen(): void {
  Notifications.setNotificationHandler({
    handleNotification: () => Promise.resolve({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

/** The Expo project this build belongs to. It is written into the app when the build is made. */
const projectId = (): string | undefined =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;

/**
 * Makes this phone take alerts for the signed-in person. With `ask` the phone's permission question is
 * shown if it has not been answered yet; without it, a phone that has not allowed alerts is left alone.
 * Safe to call on every app start.
 */
export async function enablePush(ask: boolean): Promise<PushStatus> {
  if (!Device.isDevice) return 'not_a_phone';
  const id = projectId();
  if (!id) return 'not_set_up';

  // Android needs the channel to exist before it shows anything. The server names it "default".
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Alerts', importance: Notifications.AndroidImportance.HIGH });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && ask && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') return 'denied';

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await api('/push-tokens', { method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  return 'ready';
}

/** Stops alerts to this phone for the person who is signing out. */
export async function disablePush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return;
  try {
    await api('/push-tokens/remove', { method: 'POST', body: { token } });
  } catch {
    // Offline is fine: the CRM also stops sending to a phone once its sign-in has ended.
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** Asks the CRM to send a test alert to the person's phones. Returns how many phones got it. */
export async function sendTestAlert(): Promise<number> {
  return (await api<{ phones: number }>('/push-tokens/test', { method: 'POST', body: {} })).phones;
}

/** Where tapping an alert should go: the lead if there is one, the leave screen, or the notification list. */
export function routeForAlert(data: Record<string, unknown> | undefined): string {
  const leadId = typeof data?.leadId === 'string' ? data.leadId : undefined;
  if (leadId) return `/lead/${leadId}`;
  if (data?.screen === 'leave') return '/leave';
  return '/notifications';
}
