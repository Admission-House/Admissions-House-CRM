import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { showAlertsWhileOpen } from '@/core/push';
import { PushEffects } from '@/core/push-effects';
import { SessionProvider, useSession } from '@/core/session';
import { color } from '@/core/theme';

showAlertsWhileOpen();

/** Sends people to the sign-in screen when signed out, and into the app when signed in. */
function Gate() {
  const { status, me } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const inAuth = segments[0] === 'login' || segments[0] === 'forgot-password';

  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'anonymous' && !inAuth) router.replace('/login');
    else if (status === 'authenticated' && me?.user.mustChangePassword && segments[0] !== 'change-password') router.replace('/change-password');
    else if (status === 'authenticated' && !me?.user.mustChangePassword && (inAuth || segments[0] === 'change-password')) router.replace('/');
  }, [status, me, inAuth, segments, router]);

  if (status === 'loading') {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand }}><ActivityIndicator color="#fff" /></View>;
  }
  return (
    <>
    <PushEffects />
    <Stack screenOptions={{ headerStyle: { backgroundColor: color.brand }, headerTintColor: '#fff', headerTitleStyle: { fontWeight: '700' }, contentStyle: { backgroundColor: color.canvas } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Forgot password' }} />
      <Stack.Screen name="change-password" options={{ title: 'Choose a new password', headerBackVisible: false }} />
      <Stack.Screen name="lead/[id]" options={{ title: 'Lead' }} />
      <Stack.Screen name="dialer" options={{ title: 'Auto dialer' }} />
      <Stack.Screen name="calls" options={{ title: 'Call history' }} />
      <Stack.Screen name="leave" options={{ title: 'Leave' }} />
      <Stack.Screen name="salary" options={{ title: 'My salary' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="alerts" options={{ title: 'Phone alerts' }} />
      <Stack.Screen name="account" options={{ title: 'My account' }} />
    </Stack>
    </>
  );
}

export default function Root() {
  return (
    <SessionProvider>
      <StatusBar style="light" />
      <Gate />
    </SessionProvider>
  );
}
