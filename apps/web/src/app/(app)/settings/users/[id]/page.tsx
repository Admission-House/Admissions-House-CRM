'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { EmployeeProfile } from '@/components/account/employee-profile';
import { SessionsList } from '@/components/account/sessions-list';
import { Panel } from '@/components/ui';
import { useAuth } from '@/lib/auth';

/** One person's employee details, for those who manage people. */
export default function UserProfilePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  return (
    <div className="space-y-6">
      <Link href="/settings/users" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"><ArrowLeft className="h-4 w-4" aria-hidden /> Back to users</Link>
      <EmployeeProfile path={`/users/${id}/profile`} canEditHr={can('user.manage')} title="Sign-in details" />
      {can('user.manage') && <Panel title="Where they are signed in" flush><div className="p-4"><SessionsList all userId={id} /></div></Panel>}
    </div>
  );
}

