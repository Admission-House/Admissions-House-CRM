'use client';

import { useState } from 'react';
import { Button, Field, Input, Notice, Panel } from '@/components/ui';
import { api, errorText } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/use-api';

interface Me {
  name: string;
  email: string;
  phone: string | null;
}

/** A person's own name, mobile number and sign-in email. The same for every role. A new email needs the current password. */
export function AccountDetails({ onSaved }: { onSaved?: () => void }) {
  const { me, reload } = useAuth();
  const mine = useApi<{ phone: string | null }>('/me/profile');
  const [form, setForm] = useState<{
    name?: string;
    email?: string;
    phone?: string;
    password?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  if (!me) return null;
  const name = form.name ?? me.user.name;
  const email = form.email ?? me.user.email;
  const phone = form.phone ?? mine.data?.phone ?? '';
  const emailChanged = email.trim().toLowerCase() !== me.user.email.toLowerCase();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api<Me>('/me/account', {
        method: 'PUT',
        body: {
          name: name.trim(),
          email: email.trim(),
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          ...(emailChanged ? { currentPassword: form.password ?? '' } : {}),
        },
      });
      setForm({});
      await reload();
      mine.reload();
      onSaved?.();
      setMsg({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <Panel title="My name, number and email">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="acc-name">
            <Input
              id="acc-name"
              value={name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={80}
              autoComplete="name"
            />
          </Field>
          <Field label="Mobile number" htmlFor="acc-phone">
            <Input
              id="acc-phone"
              value={phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              inputMode="tel"
              autoComplete="tel"
            />
          </Field>
          <Field label="Email (you sign in with this)" htmlFor="acc-email">
            <Input
              id="acc-email"
              type="email"
              value={email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="email"
            />
          </Field>
          {emailChanged && (
            <Field label="Current password" htmlFor="acc-pw" hint="Needed to change your email.">
              <Input
                id="acc-pw"
                type="password"
                value={form.password ?? ''}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete="current-password"
              />
            </Field>
          )}
        </div>
        {msg && (
          <div className="mt-4 max-w-2xl">
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
        <div className="mt-4">
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </div>
      </Panel>
    </form>
  );
}
