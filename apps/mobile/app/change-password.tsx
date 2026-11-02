import { useState } from 'react';
import { api } from '@/core/api';
import { useSession } from '@/core/session';
import { errorText } from '@/core/use-api';
import { Button, Card, Field, Muted, Notice, Screen } from '@/core/ui';

export default function ChangePassword() {
  const { reload, me } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (next !== again) { setError('The two new passwords are not the same.'); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setDone(true);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        {me?.user.mustChangePassword && <Muted>Choose your own password before you continue.</Muted>}
        {error && <Notice tone="bad">{error}</Notice>}
        {done && <Notice tone="ok">Password changed.</Notice>}
        <Field label="Current password" value={current} onChangeText={setCurrent} secureTextEntry autoCapitalize="none" />
        <Field label="New password" value={next} onChangeText={setNext} secureTextEntry autoCapitalize="none" autoComplete="new-password" />
        <Field label="New password again" value={again} onChangeText={setAgain} secureTextEntry autoCapitalize="none" autoComplete="new-password" />
        <Button title="Change password" onPress={() => void submit()} loading={busy} disabled={!current || !next || !again} />
      </Card>
    </Screen>
  );
}
