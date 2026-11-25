'use client';

import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui';

/** The notice shown before joining a session that is recorded. Nothing starts until the person agrees. */
export function ConsentCard({
  notice,
  onAgree,
  busy,
  onCancel,
}: {
  notice: string;
  onAgree: () => void;
  busy?: boolean;
  onCancel?: () => void;
}) {
  return (
    <div
      className="mx-auto max-w-md space-y-4 py-6 text-center"
      role="alertdialog"
      aria-labelledby="consent-title"
      aria-describedby="consent-text"
    >
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-mint text-brand">
        <ShieldCheck className="h-6 w-6" aria-hidden />
      </span>
      <h2 id="consent-title" className="text-base font-semibold text-ink">
        This session is recorded
      </h2>
      <p id="consent-text" className="whitespace-pre-line text-sm text-muted">
        {notice}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
        <Button onClick={onAgree} loading={busy}>
          I agree, join
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Do not join
          </Button>
        )}
      </div>
    </div>
  );
}
