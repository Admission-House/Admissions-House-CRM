import { Linking } from 'react-native';
import { Button, Card, Muted, Notice, Screen, Spinner, Title } from '@/core/ui';
import { usePushViewModel } from '@/viewmodels/push';

export default function Alerts() {
  const vm = usePushViewModel();

  return (
    <Screen>
      <Card>
        <Title>Alerts on this phone</Title>
        <Muted>Get a message on your phone for a new lead, a follow-up that is due, a missed call, and leave requests and decisions, even when the app is closed.</Muted>
        {vm.notice && <Notice tone={vm.notice.tone}>{vm.notice.text}</Notice>}
        {vm.status === 'checking' && <Spinner />}
        {vm.status === 'ready' && (
          <>
            <Notice tone="ok">Alerts are on for this phone.</Notice>
            <Button title="Send a test alert" icon="notifications" loading={vm.busy === 'test'} onPress={() => void vm.test()} />
          </>
        )}
        {vm.status === 'denied' && (
          <>
            <Notice tone="warn">Alerts are off. Allow notifications for this app to get them.</Notice>
            <Button title="Turn on alerts" icon="notifications" loading={vm.busy === 'enable'} onPress={() => void vm.enable()} />
            <Button title="Open phone settings" variant="secondary" onPress={() => void Linking.openSettings()} />
          </>
        )}
        {vm.status === 'not_a_phone' && <Notice tone="info">Alerts work on a real phone, not on an emulator.</Notice>}
        {vm.status === 'not_set_up' && <Notice tone="info">Alerts are not set up for this version of the app yet. Ask your admin.</Notice>}
      </Card>
    </Screen>
  );
}
