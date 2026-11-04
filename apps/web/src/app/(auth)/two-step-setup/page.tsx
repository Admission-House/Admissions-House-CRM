'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthHeading } from '@/components/auth/auth-form';
import { Setup } from '@/components/account/two-step';
import { Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/** Shown to a person whose company requires two-step sign-in and who has not set it up yet. */
export default function TwoStepSetupPage() {
  const { status, me, reload, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    else if (status === 'authenticated' && me && !me.user.mfaSetupRequired) router.replace('/dashboard');
  }, [status, me, router]);

  if (status !== 'authenticated' || !me) return <Spinner />;

  return (
    <div>
      <AuthHeading title="Set up two-step sign-in" subtitle="Your company requires a code from an authenticator app, as well as your password. It takes about a minute." />
      <div className="mt-8">
        <Setup
          cancelLabel="Sign out"
          onCancel={() => void logout().then(() => router.replace('/login'))}
          onFinished={() => void reload().then(() => router.replace('/dashboard'))}
        />
      </div>
    </div>
  );
}
