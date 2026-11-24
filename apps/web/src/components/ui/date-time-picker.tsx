'use client';

import { CalendarClock, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { cx } from '@/components/ui';
import { dayKey, fromLocalValue, monthGrid, quickChoices, TIME_SLOTS, timeLabel, toLocalValue, valueLabel } from '@/lib/date-picker';
import { useDismiss } from '@/lib/use-dismiss';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * A follow-up date and time: one-tap choices (in an hour, tomorrow 11 am...), a month calendar and half-hour times,
 * plus an exact time box. The value is the same text <input type="datetime-local"> gives ("2026-11-25T11:00"), so it
 * replaces that box without changing anything else. Days and times before `min` cannot be chosen.
 */
export function DateTimePicker({ id, value, onChange, min, required, placeholder = 'Choose date and time' }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** The earliest allowed moment, in the same "yyyy-mm-ddThh:mm" form. */
  min?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false));

  const minDate = (min && fromLocalValue(min)) || null;
  const chosen = fromLocalValue(value);
  const [shown, setShown] = useState(() => {
    const d = chosen ?? minDate ?? new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [day, setDay] = useState<string>(() => (chosen ? dayKey(chosen) : ''));
  const time = chosen ? value.slice(11, 16) : '';

  const today = dayKey(new Date());
  const minDay = minDate ? dayKey(minDate) : null;
  const dayAllowed = (d: Date) => !minDay || dayKey(d) >= minDay;
  const timeAllowed = (d: string, t: string) => !minDate || `${d}T${t}` >= toLocalValue(minDate);

  const pickDay = (d: Date) => {
    const k = dayKey(d);
    setDay(k);
    // Keep the time already chosen if it is still allowed on the new day.
    if (time && timeAllowed(k, time)) onChange(`${k}T${time}`);
    else if (chosen) onChange('');
  };
  const pickTime = (t: string) => {
    const d = day || today;
    if (!timeAllowed(d, t)) return;
    setDay(d);
    onChange(`${d}T${t}`);
    setOpen(false);
  };
  const quick = (v: string) => {
    const d = fromLocalValue(v)!;
    setDay(dayKey(d));
    setShown({ y: d.getFullYear(), m: d.getMonth() });
    onChange(v);
    setOpen(false);
  };

  const grid = monthGrid(shown.y, shown.m);
  const monthName = new Date(shown.y, shown.m, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const move = (step: number) => setShown(({ y, m }) => ({ y: m + step < 0 ? y - 1 : m + step > 11 ? y + 1 : y, m: (m + step + 12) % 12 }));
  const canGoBack = !minDate || shown.y > minDate.getFullYear() || (shown.y === minDate.getFullYear() && shown.m > minDate.getMonth());
  const dayForTimes = day || today;

  return (
    <div ref={box} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        data-required={required || undefined}
        aria-expanded={open}
        className={cx('flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-left text-sm outline-none focus-visible:border-brand', !value && 'text-subtle')}
      >
        <CalendarClock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{value ? valueLabel(value) : placeholder}</span>
        {value && (
          <span role="button" tabIndex={0} aria-label="Clear" onClick={(e) => { e.stopPropagation(); setDay(''); onChange(''); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setDay(''); onChange(''); } }} className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-head hover:text-ink">
            <X className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Choose date and time" className="absolute left-0 z-40 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-3 shadow-lg">
          <div className="flex flex-wrap gap-1.5">
            {quickChoices(new Date(), minDate ?? new Date()).map((q) => (
              <button key={q.label} type="button" onClick={() => quick(q.value)} className={cx('rounded-full border px-2.5 py-1 text-xs font-medium', value === q.value ? 'border-brand bg-mint-soft text-brand' : 'border-line text-ink hover:bg-head')}>
                {q.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button type="button" onClick={() => move(-1)} disabled={!canGoBack} aria-label="Previous month" className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-head disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
            <p className="text-sm font-semibold text-ink">{monthName}</p>
            <button type="button" onClick={() => move(1)} aria-label="Next month" className="grid h-7 w-7 place-items-center rounded text-muted hover:bg-head"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="mt-1 grid grid-cols-7 text-center text-[11px] font-medium text-subtle">
            {WEEKDAYS.map((w) => <span key={w} className="py-1">{w}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((d) => {
              const k = dayKey(d);
              const other = d.getMonth() !== shown.m;
              const ok = dayAllowed(d);
              const on = k === day;
              return (
                <button
                  key={k}
                  type="button"
                  disabled={!ok}
                  onClick={() => pickDay(d)}
                  aria-pressed={on}
                  aria-label={d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                  className={cx(
                    'tabular h-8 rounded text-sm',
                    on ? 'bg-brand font-semibold text-white' : k === today ? 'font-semibold text-brand ring-1 ring-inset ring-brand/40' : other ? 'text-subtle' : 'text-ink',
                    ok && !on && 'hover:bg-head',
                    !ok && 'cursor-not-allowed opacity-30',
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <p className="mt-3 text-xs font-medium text-muted">
            Time on {new Date(`${dayForTimes}T00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
          <div className="mt-1 grid max-h-32 grid-cols-4 gap-1 overflow-y-auto pr-1">
            {TIME_SLOTS.map((t) => {
              const ok = timeAllowed(dayForTimes, t);
              const on = time === t && day === dayForTimes;
              return (
                <button key={t} type="button" disabled={!ok} onClick={() => pickTime(t)} className={cx('tabular rounded border px-1 py-1 text-xs', on ? 'border-brand bg-brand text-white' : 'border-line text-ink hover:bg-head', !ok && 'cursor-not-allowed opacity-30')}>
                  {timeLabel(t)}
                </button>
              );
            })}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            Exact time
            <input type="time" value={time} onChange={(e) => e.target.value && pickTimeExact(e.target.value)} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" />
          </label>
        </div>
      )}
    </div>
  );

  function pickTimeExact(t: string) {
    const d = day || today;
    if (!timeAllowed(d, t)) return;
    setDay(d);
    onChange(`${d}T${t}`);
  }
}
