'use client';

import { CalendarClock, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '@/components/ui';
import {
  dayKey,
  fromLocalValue,
  monthGrid,
  quickChoices,
  TIME_SLOTS,
  timeLabel,
  toLocalValue,
  valueLabel,
} from '@/lib/date-picker';
import { useDismiss } from '@/lib/use-dismiss';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/**
 * A follow-up date and time in one compact box: one-tap choices (in an hour, tomorrow 11 am...) on top, the month on
 * the left and the free half-hour times of the chosen day on the right (an exact time box above them). The value is the same text <input type="datetime-local"> gives ("2026-11-25T11:00"), so it
 * replaces that box without changing anything else. Days and times before `min` cannot be chosen.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  min,
  required,
  placeholder = 'Choose date and time',
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** The earliest allowed moment, in the same "yyyy-mm-ddThh:mm" form. */
  min?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ up: false, right: false });
  const box = useRef<HTMLDivElement>(null);
  const slots = useRef<HTMLDivElement>(null);
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
  const monthName = new Date(shown.y, shown.m, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  const move = (step: number) =>
    setShown(({ y, m }) => ({
      y: m + step < 0 ? y - 1 : m + step > 11 ? y + 1 : y,
      m: (m + step + 12) % 12,
    }));
  const canGoBack =
    !minDate ||
    shown.y > minDate.getFullYear() ||
    (shown.y === minDate.getFullYear() && shown.m > minDate.getMonth());
  const dayForTimes = day || today;

  // The time list opens at the chosen time, or at the first time still free.
  useEffect(() => {
    if (!open) return;
    const list = slots.current;
    const target =
      list?.querySelector<HTMLElement>('[aria-pressed="true"], button.bg-brand') ??
      list?.querySelector<HTMLElement>('[data-free]');
    if (list && target) list.scrollTop = target.offsetTop - list.offsetTop;
  }, [open, dayForTimes]);

  return (
    <div ref={box} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => {
          const r = box.current?.getBoundingClientRect();
          if (r && !open) {
            setPlace({
              up: window.innerHeight - r.bottom < 360 && r.top > window.innerHeight - r.bottom,
              right: r.left + Math.min(480, window.innerWidth - 32) > window.innerWidth - 16,
            });
          }
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        data-required={required || undefined}
        aria-expanded={open}
        className={cx(
          'flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-left text-sm outline-none focus-visible:border-brand',
          !value && 'text-subtle',
        )}
      >
        <CalendarClock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{value ? valueLabel(value) : placeholder}</span>
        {value && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              setDay('');
              onChange('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                setDay('');
                onChange('');
              }
            }}
            className="grid h-6 w-6 place-items-center rounded text-muted hover:bg-head hover:text-ink"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose date and time"
          className={cx(
            // On a phone it is as wide as the field; on a wider screen a fixed width, opening to the side with room.
            'absolute inset-x-0 z-40 rounded-xl border border-line bg-surface p-3 shadow-xl sm:inset-x-auto sm:w-[30rem]',
            place.up ? 'bottom-full mb-1' : 'top-full mt-1',
            place.right ? 'sm:right-0' : 'sm:left-0',
          )}
        >
          {/* One line of one-tap choices; it scrolls sideways on a narrow screen. */}
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {quickChoices(new Date(), minDate ?? new Date()).map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => quick(q.value)}
                className={cx(
                  'h-7 shrink-0 whitespace-nowrap rounded-full border px-2.5 text-xs font-medium',
                  value === q.value
                    ? 'border-brand bg-mint-soft text-brand'
                    : 'border-line text-ink hover:border-brand/40 hover:bg-head',
                )}
              >
                {q.label}
              </button>
            ))}
          </div>

          <div className="mt-2 grid gap-3 border-t border-line pt-2 sm:grid-cols-[1fr_8.5rem]">
            {/* The month */}
            <div>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => move(-1)}
                  disabled={!canGoBack}
                  aria-label="Previous month"
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-head disabled:opacity-30"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <p className="text-[13px] font-semibold text-ink">{monthName}</p>
                <button
                  type="button"
                  onClick={() => move(1)}
                  aria-label="Next month"
                  className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-head"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-1 grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wide text-subtle">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="py-0.5">
                    {w}
                  </span>
                ))}
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
                      aria-label={d.toLocaleDateString('en-IN', {
                        weekday: 'long',
                        day: 'numeric',
                        month: 'long',
                      })}
                      className={cx(
                        'tabular h-7 rounded-md text-[13px]',
                        on
                          ? 'bg-brand font-semibold text-white'
                          : k === today
                            ? 'font-semibold text-brand ring-1 ring-inset ring-brand/40'
                            : other
                              ? 'text-subtle'
                              : 'text-ink',
                        ok && !on && 'hover:bg-head',
                        !ok && 'cursor-not-allowed opacity-25',
                      )}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* The time, for the day chosen (today until one is chosen) */}
            <div className="flex min-h-0 flex-col sm:border-l sm:border-line sm:pl-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
                {new Date(`${dayForTimes}T00:00`).toLocaleDateString('en-IN', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </p>
              <input
                type="time"
                aria-label="Exact time"
                title="Exact time"
                value={time}
                onChange={(e) => e.target.value && pickTimeExact(e.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-[13px] text-ink"
              />
              <div
                ref={slots}
                className="mt-1.5 grid max-h-28 grid-cols-4 gap-1 overflow-y-auto pr-0.5 sm:max-h-[11.5rem] sm:grid-cols-1"
              >
                {TIME_SLOTS.map((t) => {
                  const ok = timeAllowed(dayForTimes, t);
                  const on = time === t && day === dayForTimes;
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={!ok}
                      data-free={ok || undefined}
                      onClick={() => pickTime(t)}
                      className={cx(
                        'tabular h-7 shrink-0 rounded-md text-xs',
                        on ? 'bg-brand font-semibold text-white' : 'text-ink hover:bg-head',
                        !ok && 'hidden',
                      )}
                    >
                      {timeLabel(t)}
                    </button>
                  );
                })}
                {TIME_SLOTS.every((t) => !timeAllowed(dayForTimes, t)) && (
                  <p className="col-span-4 py-2 text-xs text-subtle">
                    No times left today. Choose another day.
                  </p>
                )}
              </div>
            </div>
          </div>
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
