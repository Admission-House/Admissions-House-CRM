/**
 * The arithmetic behind the follow-up date-and-time picker, kept apart from the screen so it can be tested.
 * Values are local date-times written the way <input type="datetime-local"> writes them: "2026-11-25T11:00".
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A Date as "yyyy-mm-ddThh:mm" in the viewer's own time. */
export function toLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "yyyy-mm-ddThh:mm" back to a Date in the viewer's own time; null when it is not one. */
export function fromLocalValue(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The earliest follow-up time a form offers: five minutes from now. */
export const minFollowUp = (): string => toLocalValue(new Date(Date.now() + 5 * 60_000));

/** A "yyyy-mm-ddThh:mm" local value as the full timestamp the API wants. */
export const localToIso = (local: string): string => new Date(local).toISOString();

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The days to show for a month, Monday first: whole weeks, with the days of the months around it to fill them. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(year, month, 1 - lead);
  const last = new Date(year, month + 1, 0);
  const cells = lead + last.getDate();
  const weeks = Math.ceil(cells / 7);
  return Array.from(
    { length: weeks * 7 },
    (_x, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
}

/** Times of day offered as buttons: every half hour from 9:00 to 20:30. */
export const TIME_SLOTS: string[] = Array.from(
  { length: 24 },
  (_x, i) => `${pad(9 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`,
);

/** "11:00" as "11:00 am", "16:30" as "4:30 pm". */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`;
}

/** The one-tap choices, those still ahead of `min`: in an hour, this evening, tomorrow morning and afternoon, next Monday. */
export function quickChoices(now: Date, min: Date): { label: string; value: string }[] {
  const at = (days: number, h: number, m = 0) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m);
  const inHour = new Date(now.getTime() + 60 * 60_000);
  inHour.setSeconds(0, 0);
  // Round up to the next 5 minutes, so the time reads cleanly.
  inHour.setMinutes(Math.ceil(inHour.getMinutes() / 5) * 5);
  const toMonday = (8 - now.getDay()) % 7 || 7;
  const list = [
    { label: 'In 1 hour', date: inHour },
    { label: 'This evening, 6 pm', date: at(0, 18) },
    { label: 'Tomorrow, 11 am', date: at(1, 11) },
    { label: 'Tomorrow, 4 pm', date: at(1, 16) },
    { label: 'Next Monday, 11 am', date: at(toMonday, 11) },
  ];
  return list
    .filter((c) => c.date.getTime() >= min.getTime())
    .map((c) => ({ label: c.label, value: toLocalValue(c.date) }));
}

/** How a chosen value reads on the button: "Tue, 25 Nov 2026 · 11:00 am". */
export function valueLabel(v: string): string {
  const d = fromLocalValue(v);
  if (!d) return '';
  const day = d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${day} · ${timeLabel(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}`;
}
