'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Notice, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { SETTINGS_BUILT } from '@/lib/settings-nav';

/** Opens the first settings page this person is allowed to use. */
export default function SettingsHome() {
  const { canAny } = useAuth();
  const router = useRouter();
  const first = SETTINGS_BUILT.flatMap((g) => g.items).find((i) => canAny(...i.any));

  useEffect(() => {
    if (first) router.replace(first.href);
  }, [first, router]);

  return first ? <Spinner /> : <Notice tone="warn">Your role does not include any settings.</Notice>;
}
