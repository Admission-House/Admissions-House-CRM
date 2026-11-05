/**
 * The payroll calculation, as pure functions: facts about a month go in, a payslip comes out. It reads
 * no database and no clock, so every rule can be tested with plain numbers.
 *
 *   pay of one day  = base pay / the days of the basis (calendar days, or working days)
 *   deductions      = absent days, unpaid leave, half days and late arrivals (each a number of days of pay),
 *                     plus break overrun (rupees per minute), plus the fixed deductions of the structure
 *   net pay         = base pay + allowances - all deductions
 *
 * Money is handled in paise (whole numbers), so 0.1 + 0.2 style errors cannot creep in.
 */

export interface PayrollPolicy {
  workingDaysBasis: 'calendar' | 'working';
  lateFreePerMonth: number;
  latePenaltyDays: number;
  halfDayDeductionDays: number;
  absentDeductionDays: number;
  unpaidLeaveDeductionDays: number;
  breakOverrunPerMinute: number;
}

export interface StructureLine {
  label: string;
  amount: number;
}

export interface Structure {
  basePay: number;
  allowances: StructureLine[];
  deductions: StructureLine[];
}

export interface DayFacts {
  /** YYYY-MM-DD */
  date: string;
  /** Not a weekly off and not a holiday. */
  isWorking: boolean;
  /** The person had not joined yet on this day. */
  beforeJoining?: boolean;
  attendance?: {
    lateMinutes: number;
    /** Minutes at work minus breaks; null while the day is still open. */
    workedMinutes: number | null;
    /** A day worked for fewer minutes than this counts as a half day. */
    halfDayBelowMinutes: number;
    /** Break minutes beyond the allowance on this day. */
    breakOverMinutes: number;
  };
  /** The part of this day covered by approved leave: 1 for a full day, 0.5 for a half day. */
  leave?: { share: number; paid: boolean };
}

export interface PayslipLine {
  kind: 'earning' | 'deduction';
  label: string;
  amount: number;
  source: 'structure' | 'attendance';
  detail?: string;
}

export interface PayslipResult {
  basisDays: number;
  workingDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  absentDays: number;
  halfDays: number;
  lateCount: number;
  breakOverMinutes: number;
  dailyRate: number;
  lines: PayslipLine[];
  gross: number;
  deductions: number;
  net: number;
}

export const toPaise = (rupees: number): number => Math.round(rupees * 100);
export const toRupees = (paise: number): number => paise / 100;
const days = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 ? 'day' : 'days'}`;

/** The days of leave that fall on each date of a request: its days spread over its working dates. */
export function leaveShare(requestDays: number, workingDatesInRequest: number): number {
  if (workingDatesInRequest <= 0) return 0;
  return Math.min(1, requestDays / workingDatesInRequest);
}

export function calculatePayslip(input: { policy: PayrollPolicy; structure: Structure; days: readonly DayFacts[]; calendarDays: number }): PayslipResult {
  const { policy, structure } = input;
  const month = input.days;

  let workingDays = 0;
  let present = 0;
  let paidLeave = 0;
  let unpaidLeave = 0;
  let absent = 0;
  let half = 0;
  let late = 0;
  let notJoined = 0;
  let breakOver = 0;

  for (const d of month) {
    if (!d.isWorking) continue;
    workingDays += 1;
    if (d.beforeJoining) {
      notJoined += 1;
      continue;
    }
    if (d.attendance) {
      present += 1;
      if (d.attendance.lateMinutes > 0) late += 1;
      if (d.attendance.workedMinutes !== null && d.attendance.workedMinutes < d.attendance.halfDayBelowMinutes) half += 1;
      breakOver += d.attendance.breakOverMinutes;
    } else if (d.leave) {
      const share = Math.min(1, Math.max(0, d.leave.share));
      if (d.leave.paid) paidLeave += share;
      else unpaidLeave += share;
      absent += 1 - share;
    } else {
      absent += 1;
    }
  }

  const basisDays = policy.workingDaysBasis === 'calendar' ? input.calendarDays : workingDays;
  const basePaise = toPaise(structure.basePay);
  // The pay of a number of days, rounded to the paise.
  const forDays = (n: number): number => (basisDays > 0 ? Math.round((basePaise * n) / basisDays) : 0);
  const dailyRate = basisDays > 0 ? toRupees(Math.round(basePaise / basisDays)) : 0;

  const lines: PayslipLine[] = [{ kind: 'earning', label: 'Base pay', amount: structure.basePay, source: 'structure' }];
  for (const a of structure.allowances) lines.push({ kind: 'earning', label: a.label, amount: a.amount, source: 'structure' });
  for (const f of structure.deductions) lines.push({ kind: 'deduction', label: f.label, amount: f.amount, source: 'structure' });

  const cut = (label: string, deductDays: number, detail: string): void => {
    const paise = forDays(deductDays);
    if (paise > 0) lines.push({ kind: 'deduction', label, amount: toRupees(paise), source: 'attendance', detail });
  };
  cut('Absent without leave', absent * policy.absentDeductionDays, `${days(absent)} with no attendance and no approved leave`);
  cut('Unpaid leave', unpaidLeave * policy.unpaidLeaveDeductionDays, `${days(unpaidLeave)} of leave that is not paid`);
  cut('Half days', half * policy.halfDayDeductionDays, `${half} ${half === 1 ? 'day' : 'days'} worked for fewer hours than a full day`);
  const lateBeyond = Math.max(0, late - policy.lateFreePerMonth);
  cut('Late arrivals', lateBeyond * policy.latePenaltyDays, `${late} late ${late === 1 ? 'arrival' : 'arrivals'}, ${policy.lateFreePerMonth} free`);
  cut('Before joining date', notJoined, `${days(notJoined)} of the month before the person joined`);
  const breakPaise = toPaise(policy.breakOverrunPerMinute) * breakOver;
  if (breakPaise > 0) lines.push({ kind: 'deduction', label: 'Break overrun', amount: toRupees(breakPaise), source: 'attendance', detail: `${breakOver} minutes beyond the allowed break time` });

  const sum = (kind: PayslipLine['kind']): number => lines.filter((l) => l.kind === kind).reduce((s, l) => s + toPaise(l.amount), 0);
  const gross = sum('earning');
  const deductions = sum('deduction');
  return {
    basisDays, workingDays, presentDays: present, paidLeaveDays: paidLeave, unpaidLeaveDays: unpaidLeave, absentDays: absent, halfDays: half, lateCount: late,
    breakOverMinutes: breakOver, dailyRate, lines, gross: toRupees(gross), deductions: toRupees(deductions), net: toRupees(gross - deductions),
  };
}

/** Every date of a month (YYYY-MM) with its weekday, 0 = Sunday. */
export function monthDays(month: string): { date: string; weekday: number }[] {
  const [y, m] = month.slice(0, 7).split('-').map(Number) as [number, number];
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(Date.UTC(y, m - 1, i + 1));
    return { date: dt.toISOString().slice(0, 10), weekday: dt.getUTCDay() };
  });
}
