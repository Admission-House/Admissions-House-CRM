'use client';

import { usePathname } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { SETTINGS_BUILT } from '@/lib/settings-nav';

/** The admin area. Its pages are listed in the sidebar, so the page shows only the title of the one that is open. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const open = SETTINGS_BUILT.flatMap((g) => g.items).find((i) => path === i.href || path.startsWith(`${i.href}/`));
  return (
    <>
      <PageHeader title={open?.label ?? 'Settings'} subtitle={open?.description ?? 'Set up your people, access and office'} />
      {children}
    </>
  );
}
