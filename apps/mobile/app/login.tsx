import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { config } from '@/core/config';
import { lastTenant, useSession } from '@/core/session';
import { color, space } from '@/core/theme';
import { errorText } from '@/core/use-api';
import { Button, Field, Notice } from '@/core/ui';

export default function Login() {
  const { login } = useSession();
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void lastTenant().then((t) => t && setTenant(t)); }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login({ tenant: tenant.trim().toLowerCase(), email: email.trim().toLowerCase(), password });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.brand }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <Text style={s.brand}>{config.productName}</Text>
        <Text style={s.tag}>Every student, every follow-up, in one place.</Text>
        <View style={s.card}>
          {error && <Notice tone="bad">{error}</Notice>}
          {!config.companySlug && <Field label="Company" value={tenant} onChangeText={setTenant} autoCapitalize="none" autoCorrect={false} placeholder="your-company" />}
          <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete="current-password" textContentType="password" onSubmitEditing={() => void submit()} />
          <Button title="Sign in" onPress={() => void submit()} loading={busy} disabled={!tenant || !email || !password} />
          <Link href="/forgot-password" style={s.link}>Forgot password?</Link>
        </View>
        <Text style={s.note}>Office staff sign in from the office. The app may ask for your location to confirm it.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  body: { flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.lg },
  brand: { color: '#fff', fontSize: 28, fontWeight: '800' },
  tag: { color: color.mint, fontSize: 15, marginBottom: space.sm },
  card: { backgroundColor: color.surface, borderRadius: 16, padding: space.xl, gap: space.lg },
  link: { color: color.brand600, fontWeight: '600', textAlign: 'center', padding: space.sm },
  note: { color: color.mint, fontSize: 12, textAlign: 'center' },
});
