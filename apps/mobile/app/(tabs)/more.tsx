import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert, Pressable, Text, View } from 'react-native';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { useApi } from '@/core/use-api';
import { Badge, Card, Muted, Screen } from '@/core/ui';

type Icon = React.ComponentProps<typeof Ionicons>['name'];

function Item({ icon, label, onPress, badge }: { icon: Icon; label: string; onPress: () => void; badge?: number }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, opacity: pressed ? 0.6 : 1 })}>
      <Ionicons name={icon} size={22} color={color.brand600} />
      <Text style={{ flex: 1, fontSize: 16, color: color.ink, fontWeight: '600' }}>{label}</Text>
      {!!badge && <Badge tone="bad">{String(badge)}</Badge>}
      <Ionicons name="chevron-forward" size={18} color={color.subtle} />
    </Pressable>
  );
}

export default function More() {
  const { me, can, logout } = useSession();
  const router = useRouter();
  const unread = useApi<{ unread: number }>('/notifications/unread-count');

  function confirmLogout() {
    Alert.alert('Sign out', 'Sign out of this phone?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void logout() },
    ]);
  }

  return (
    <Screen onRefresh={unread.reload}>
      <Card>
        <Text style={{ fontSize: 18, fontWeight: '800', color: color.ink }}>{me?.user.name}</Text>
        <Muted>{me?.user.email}</Muted>
        <Muted>{me?.company.name}</Muted>
      </Card>
      <Card>
        <Item icon="notifications-outline" label="Notifications" badge={unread.data?.unread} onPress={() => router.push('/notifications')} />
        {can('dialer.use') && can('call.place') && <Item icon="keypad-outline" label="Auto dialer" onPress={() => router.push('/dialer')} />}
        {can('call.read') && <Item icon="call-outline" label="Call history" onPress={() => router.push('/calls')} />}
        {can('leave.request') && <Item icon="airplane-outline" label="Leave" onPress={() => router.push('/leave')} />}
        {can('salary.read_own') && <Item icon="wallet-outline" label="My salary" onPress={() => router.push('/salary')} />}
        <Item icon="notifications-circle-outline" label="Phone alerts" onPress={() => router.push('/alerts')} />
        <Item icon="person-circle-outline" label="My account" onPress={() => router.push('/account')} />
      </Card>
      <Pressable accessibilityRole="button" onPress={confirmLogout} style={{ padding: 14, alignItems: 'center' }}>
        <View><Text style={{ color: color.bad, fontWeight: '700', fontSize: 16 }}>Sign out</Text></View>
      </Pressable>
    </Screen>
  );
}
