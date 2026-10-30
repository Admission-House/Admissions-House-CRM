'use client';

import Link from 'next/link';
import { useState } from 'react';
import { EmployeeProfile } from '@/components/account/employee-profile';
import { SessionsList } from '@/components/account/sessions-list';
import { PageHeader, Panel, Tabs } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/** The signed-in person's own page: their details, where they are signed in, and their password. */
export default function AccountPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'profile' | 'devices' | 'password'>('profile');
  return (
    <>
      <PageHeader title="My account" subtitle="Your details, the places you are signed in, and your password" />
      <div className="space-y-4">
        <div className="overflow-hidden rounded-lg border border-line"><Tabs tabs={[{ key: 'profile' as const, label: 'My details' }, { key: 'devices' as const, label: 'Where I am signed in' }, { key: 'password' as const, label: 'Password' }]} value={tab} onChange={setTab} label="My account" /></div>
        {tab === 'profile' && <EmployeeProfile path="/me/profile" canEditHr={can('user.manage')} />}
        {tab === 'devices' && <SessionsList />}
        {tab === 'password' && (
          <Panel title="Password">
            <p className="max-w-xl text-sm text-muted">Choose a new password now and again whenever you think someone else may know it. You stay signed in on this device and are signed out of the others.</p>
            <Link href="/change-password" className="mt-4 inline-flex h-10 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-700">Change password</Link>
          </Panel>
        )}
      </div>
    </>
  );
}
