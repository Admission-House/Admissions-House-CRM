const date = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

export const fmtDate = (iso: string | Date | null | undefined) => (iso ? date.format(new Date(iso)) : '');
export const fmtDateTime = (iso: string | Date | null | undefined) => (iso ? `${date.format(new Date(iso))}, ${time.format(new Date(iso)).toLowerCase()}` : '');
export const fmtTime = (iso: string | Date | null | undefined) => (iso ? time.format(new Date(iso)).toLowerCase() : '');

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
export const fmtPhone = (phone: string) => (/^91\d{10}$/.test(phone) ? `+91 ${phone.slice(2, 7)} ${phone.slice(7)}` : `+${phone}`);
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const monthName = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
/** A local date as YYYY-MM-DD, without the UTC shift toISOString would cause. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
