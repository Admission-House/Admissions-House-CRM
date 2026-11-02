import { useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { enablePush, routeForAlert } from './push';
import { useSession } from './session';

/**
 * Sits inside the signed-in app and does two things: makes this phone take alerts once the person is
 * signed in, and opens the right screen when they tap an alert (including when the tap started the app).
 */
export function PushEffects(): null {
  const { status, me } = useSession();
  const router = useRouter();
  const ready = status === 'authenticated' && !!me && !me.user.mustChangePassword;

  useEffect(() => {
    if (!ready) return;
    // A refusal or a missing push setup is not an error to show on every start; the Phone alerts screen explains it.
    void enablePush(true).catch(() => undefined);
  }, [ready]);

  const last = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = last.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    router.push(routeForAlert(last.notification.request.content.data as Record<string, unknown> | undefined));
  }, [ready, last, router]);

  return null;
}
