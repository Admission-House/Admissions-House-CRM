import { useEffect, useState } from 'react';
import { api } from '@/core/api';
import { lastTenant } from '@/core/session';
import { config } from '@/core/config';
import { errorText } from '@/core/use-api';
import { Button, Card, Field, Muted, Notice, Screen } from '@/core/ui';

export default function ForgotPassword() {
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void lastTenant().then((t) => t && setTenant(t)); }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', anonymous: true, body: { tenant: tenant.trim().toLowerCase(), email: email.trim().toLowerCase() } });
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Muted>Enter your email. If it matches an account, we send a link to choose a new password.</Muted>
        {error && <Notice tone="bad">{error}</Notice>}
        {sent && <Notice tone="ok">If that email has an account, a link is on its way. It works for a short time only.</Notice>}
        {!config.companySlug && <Field label="Company" value={tenant} onChangeText={setTenant} autoCapitalize="none" autoCorrect={false} />}
        <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
        <Button title="Send link" onPress={() => void submit()} loading={busy} disabled={!tenant || !email} />
      </Card>
    </Screen>
  );
}
