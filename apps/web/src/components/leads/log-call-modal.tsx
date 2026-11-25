'use client';

import { PhoneCall } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input, Notice, cx } from '@/components/ui';
import { Modal } from '@/components/ui/modal';
import { api, errorText } from '@/lib/api';
import { fmtPhone } from '@/lib/format';

type Direction = 'outgoing' | 'incoming';
type Outcome = 'connected' | 'not_picked' | 'busy' | 'failed' | 'missed';

const CHOICES: Record<Direction, { key: Outcome; label: string }[]> = {
  outgoing: [
    { key: 'connected', label: 'Connected' },
    { key: 'not_picked', label: 'Not picked' },
    { key: 'busy', label: 'Busy' },
    { key: 'failed', label: 'Switched off / not reachable' },
  ],
  incoming: [
    { key: 'connected', label: 'I answered' },
    { key: 'missed', label: 'I missed it' },
  ],
};

/** The number to dial from a phone: +91... so the dialer never guesses the country. */
export const telHref = (phone: string) => `tel:+${phone.replace(/\D/g, '')}`;

/**
 * "How did the call go?" for a call made from the counsellor's own mobile. The CRM cannot see such a call, so the
 * counsellor writes the result down; it is then counted in Calls today, Missed calls, the Calls page and reports.
 */
export function LogCallModal({
  leadId,
  leadName,
  phone,
  onClose,
  onSaved,
}: {
  leadId: string;
  leadName: string;
  phone: string;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const [direction, setDirection] = useState<Direction>('outgoing');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!outcome) {
      setError('Choose what happened on the call.');
      return;
    }
    const m = minutes.trim() === '' ? 0 : Number(minutes);
    if (outcome === 'connected' && (!Number.isInteger(m) || m < 0 || m > 300)) {
      setError('Talk time is whole minutes, from 0 to 300.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/leads/${leadId}/calls/log`, {
        method: 'POST',
        body: { direction, outcome, ...(outcome === 'connected' && { minutes: m }) },
      });
      onSaved('Call saved. Now update the lead in Dispose lead.');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="How did the call go?" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-head px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{leadName}</p>
            <p className="tabular text-base font-semibold text-ink">{fmtPhone(phone)}</p>
          </div>
          <a
            href={telHref(phone)}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-brand px-3 text-sm font-medium text-white hover:bg-brand-600"
          >
            <PhoneCall className="h-4 w-4" aria-hidden /> Dial
          </a>
        </div>

        <div
          role="radiogroup"
          aria-label="Who called"
          className="grid grid-cols-2 gap-1 rounded-md bg-head p-1"
        >
          {(['outgoing', 'incoming'] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={direction === d}
              onClick={() => {
                setDirection(d);
                setOutcome(null);
              }}
              className={cx(
                'rounded px-3 py-1.5 text-sm font-medium',
                direction === d ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
              )}
            >
              {d === 'outgoing' ? 'I called the student' : 'The student called me'}
            </button>
          ))}
        </div>

        <div role="radiogroup" aria-label="What happened" className="flex flex-wrap gap-2">
          {CHOICES[direction].map((c) => (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={outcome === c.key}
              onClick={() => setOutcome(c.key)}
              className={cx(
                'rounded-full border px-3 py-1.5 text-sm font-medium',
                outcome === c.key
                  ? 'border-brand bg-mint-soft text-brand'
                  : 'border-line text-ink hover:bg-head',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        {outcome === 'connected' && (
          <Field
            label="Talk time (minutes)"
            htmlFor="talk"
            hint="Roughly is fine. 0 if it was less than a minute."
          >
            <Input
              id="talk"
              type="number"
              inputMode="numeric"
              min={0}
              max={300}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              className="w-32"
              placeholder="0"
            />
          </Field>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Not now
        </Button>
        <Button onClick={() => void save()} loading={busy}>
          Save call
        </Button>
      </div>
    </Modal>
  );
}
