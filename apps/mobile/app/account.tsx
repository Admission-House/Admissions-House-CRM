import { useRouter } from 'expo-router';
import { Alert, Text, View } from 'react-native';
import { api } from '@/core/api';
import { fromNow } from '@/core/format';
import { useSession } from '@/core/session';
import { color } from '@/core/theme';
import { errorText, useApi } from '@/core/use-api';
import { Badge, Button, Card, Muted, Notice, Row, Screen, Spinner, Title } from '@/core/ui';
import { useState } from 'react';

interface SessionRow { id: string; current: boolean; clientType: string; ip: string | null; userAgent: string | null; signedInAt: string; lastActiveAt: string }

export default function Account() {
  const { me } = useSession();
  const router = useRouter();
  const sessions = useApi<SessionRow[]>('/auth/sessions');
  const [error, setError] = useState<string | null>(null);

  function end(s: SessionRow) {
    Alert.alert('Sign out that device?', 'It will need to sign in again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => { setError(null); api(`/auth/sessions/${s.id}`, { method: 'DELETE' }).then(sessions.reload).catch((e: unknown) => setError(errorText(e))); } },
    ]);
  }

  return (
    <Screen onRefresh={sessions.reload}>
      <Card>
        <Row label="Name" value={me?.user.name} />
        <Row label="Email" value={me?.user.email} />
        <Row label="Role" value={me?.user.role.key?.replace(/_/g, ' ')} />
        <Row label="Company" value={me?.company.name} />
        <Button title="Change password" variant="secondary" onPress={() => router.push('/change-password')} />
      </Card>
      <Card>
        <Title>Where you are signed in</Title>
        {error && <Notice tone="bad">{error}</Notice>}
        {!sessions.data ? <Spinner /> : sessions.data.map((s) => (
          <View key={s.id} style={{ paddingVertical: 8, gap: 2, borderTopWidth: 1, borderTopColor: color.line }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={{ color: color.ink, fontWeight: '600' }}>{s.clientType === 'mobile' ? 'Phone app' : 'Web browser'}</Text>
              {s.current && <Badge tone="ok">This device</Badge>}
            </View>
            <Muted>Last active {fromNow(s.lastActiveAt)}{s.ip ? ` · ${s.ip}` : ''}</Muted>
            {!s.current && <Button title="Sign out" variant="secondary" onPress={() => end(s)} />}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
