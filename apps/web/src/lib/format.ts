/** Dates are shown in the viewer's own time zone, in the Indian style (28 Oct 2026, 3:30 pm). */
const date = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

export const fmtDate = (iso: string | Date | null | undefined) => (iso ? date.format(new Date(iso)) : '');
export const fmtDateTime = (iso: string | Date | null | undefined) => (iso ? `${date.format(new Date(iso))}, ${time.format(new Date(iso)).toLowerCase()}` : '');

/** "in 2 hours", "3 days ago" */
export function fromNow(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute']];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      const label = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return diff < 0 ? 'just now' : 'in a moment';
}

/** 919876543210 becomes +91 98765 43210 */
export function fmtPhone(phone: string): string {
  return /^91\d{10}$/.test(phone) ? `+91 ${phone.slice(2, 7)} ${phone.slice(7)}` : `+${phone}`;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

/** Minutes as a person reads them: "45 min", "1 h", "11 h 59 min". */
export function fmtMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "Good morning" until noon (from 4 am), "Good afternoon" until 5 pm, "Good evening" after that, by the viewer's own clock. */
export function greeting(at: Date = new Date()): string {
  const h = at.getHours();
  if (h >= 4 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The first word of a person's name, for a friendly greeting: "Riya Sharma" becomes "Riya". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';
