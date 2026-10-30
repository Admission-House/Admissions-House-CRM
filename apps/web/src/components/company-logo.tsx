'use client';

import { useEffect, useState } from 'react';
import { Logo } from '@/components/brand';
import { apiRaw } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * The company's own logo when it has uploaded one, else the product's mark. The picture is private,
 * so it is fetched with the person's sign-in and shown from memory.
 */
export function CompanyLogo({ size = 36 }: { size?: number }) {
  const { me } = useAuth();
  const wanted = !!me?.company.hasLogo;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let made: string | null = null;
    let cancelled = false;
    apiRaw('/company/logo')
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [wanted]);

  if (wanted && url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={me?.company.name ?? 'Logo'} style={{ height: size, width: 'auto', maxWidth: size * 3 }} className="rounded-md object-contain" />;
  }
  return <span className="grid place-items-center rounded-lg bg-mint" style={{ width: size, height: size }}><Logo size={Math.round(size * 0.72)} /></span>;
}
