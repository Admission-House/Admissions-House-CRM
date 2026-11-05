import { describe, expect, it } from 'vitest';
import { calculatePayslip, DayFacts, leaveShare, monthDays, PayrollPolicy, Structure } from './payroll-calc.js';

const POLICY: PayrollPolicy = {
  workingDaysBasis: 'working',
  lateFreePerMonth: 3,
  latePenaltyDays: 0.25,
  halfDayDeductionDays: 0.5,
  absentDeductionDays: 1,
  unpaidLeaveDeductionDays: 1,
  breakOverrunPerMinute: 0,
};
const STRUCTURE: Structure = { basePay: 30000, allowances: [], deductions: [] };

/** A 30-day month in which 26 days are working days (four Sundays off). Everyone attends on time unless a test changes a day. */
function month(change: (d: DayFacts, i: number) => void = () => {}): DayFacts[] {
  const days: DayFacts[] = monthDays('2026-09').map(({ date, weekday }) => ({
    date,
    isWorking: weekday !== 0,
    attendance: weekday === 0 ? undefined : { lateMinutes: 0, workedMinutes: 540, halfDayBelowMinutes: 270, breakOverMinutes: 0 },
  }));
  days.forEach(change);
  return days;
}
const run = (days: DayFacts[], over: { policy?: Partial<PayrollPolicy>; structure?: Partial<Structure> } = {}) =>
  calculatePayslip({ policy: { ...POLICY, ...over.policy }, structure: { ...STRUCTURE, ...over.structure }, days, calendarDays: days.length });
const line = (r: ReturnType<typeof run>, label: string) => r.lines.find((l) => l.label === label);

describe('a clean month', () => {
  it('pays the base pay and the structure, and takes only the fixed deductions', () => {
    const r = run(month(), { structure: { basePay: 30000, allowances: [{ label: 'HRA', amount: 6000 }], deductions: [{ label: 'PF', amount: 1800 }] } });
    expect(r).toMatchObject({ workingDays: 26, presentDays: 26, absentDays: 0, lateCount: 0, halfDays: 0, gross: 36000, deductions: 1800, net: 34200 });
    expect(r.lines.map((l) => `${l.kind}:${l.label}`)).toEqual(['earning:Base pay', 'earning:HRA', 'deduction:PF']);
  });
});

describe('absent days', () => {
  it('takes a day of pay for each working day with no attendance and no leave', () => {
    const days = month((d, i) => { if (i === 1 || i === 2) d.attendance = undefined; });
    const r = run(days);
    expect(r.absentDays).toBe(2);
    expect(r.dailyRate).toBe(1153.85);
    expect(line(r, 'Absent without leave')).toMatchObject({ kind: 'deduction', amount: 2307.69, source: 'attendance' });
    expect(r.net).toBe(27692.31);
  });

  it('does not count a weekly off or a holiday as absent, and ignores attendance on them', () => {
    const days = month((d, i) => { if (i === 4) { d.isWorking = false; d.attendance = undefined; } });
    const r = run(days);
    expect(r.workingDays).toBe(25);
    expect(r.absentDays).toBe(0);
    expect(r.lines.some((l) => l.label === 'Absent without leave')).toBe(false);
  });

  it('follows the rule value the company set', () => {
    const days = month((d, i) => { if (i === 1) d.attendance = undefined; });
    expect(line(run(days, { policy: { absentDeductionDays: 2 } }), 'Absent without leave')?.amount).toBe(2307.69);
    expect(line(run(days, { policy: { absentDeductionDays: 0 } }), 'Absent without leave')).toBeUndefined();
  });
});

describe('leave', () => {
  it('does not take anything for paid leave', () => {
    const days = month((d, i) => { if (i === 1) { d.attendance = undefined; d.leave = { share: 1, paid: true }; } });
    const r = run(days);
    expect(r).toMatchObject({ paidLeaveDays: 1, absentDays: 0, deductions: 0, net: 30000 });
  });

  it('takes a day of pay for unpaid leave, at the rule value', () => {
    const days = month((d, i) => { if (i === 1) { d.attendance = undefined; d.leave = { share: 1, paid: false }; } });
    expect(line(run(days), 'Unpaid leave')?.amount).toBe(1153.85);
    expect(line(run(days, { policy: { unpaidLeaveDeductionDays: 0.5 } }), 'Unpaid leave')?.amount).toBe(576.92);
  });

  it('counts a half day of leave as half leave and half absent', () => {
    const days = month((d, i) => { if (i === 1) { d.attendance = undefined; d.leave = { share: 0.5, paid: true }; } });
    const r = run(days);
    expect(r).toMatchObject({ paidLeaveDays: 0.5, absentDays: 0.5 });
    expect(line(r, 'Absent without leave')?.amount).toBe(576.92);
  });

  it('lets attendance win on a day that also has leave', () => {
    const days = month((d, i) => { if (i === 1) d.leave = { share: 1, paid: false }; });
    expect(run(days)).toMatchObject({ presentDays: 26, unpaidLeaveDays: 0, deductions: 0 });
  });

  it('spreads the days of a request over its working dates', () => {
    expect(leaveShare(3, 3)).toBe(1);
    expect(leaveShare(0.5, 1)).toBe(0.5);
    expect(leaveShare(2, 0)).toBe(0);
    expect(leaveShare(9, 3)).toBe(1);
  });
});

describe('half days', () => {
  it('takes half a day of pay when fewer hours than the half-day line were worked', () => {
    const days = month((d, i) => { if (i === 1 && d.attendance) d.attendance.workedMinutes = 269; });
    const r = run(days);
    expect(r.halfDays).toBe(1);
    expect(line(r, 'Half days')?.amount).toBe(576.92);
  });

  it('does not count a day worked exactly the half-day line, or one that is still open', () => {
    const days = month((d, i) => {
      if (i === 1 && d.attendance) d.attendance.workedMinutes = 270;
      if (i === 2 && d.attendance) d.attendance.workedMinutes = null;
    });
    expect(run(days).halfDays).toBe(0);
  });
});

describe('late arrivals', () => {
  const lateOn = (n: number) => month((d, i) => { if (d.attendance && i < n) d.attendance.lateMinutes = 15; });

  it('is free up to the allowed number a month', () => {
    const r = run(lateOn(3));
    expect(r.lateCount).toBe(3);
    expect(line(r, 'Late arrivals')).toBeUndefined();
  });

  it('takes a part of a day for each one beyond that', () => {
    const r = run(lateOn(5)); // 5 late - 3 free = 2, at a quarter day each = half a day
    expect(r.lateCount).toBe(5);
    expect(line(r, 'Late arrivals')?.amount).toBe(576.92);
  });

  it('can be switched off', () => {
    expect(line(run(lateOn(10), { policy: { latePenaltyDays: 0 } }), 'Late arrivals')).toBeUndefined();
  });
});

describe('break overrun', () => {
  const over = month((d, i) => { if (d.attendance && (i === 1 || i === 2)) d.attendance.breakOverMinutes = 6; });

  it('is off while the rate is 0', () => {
    expect(run(over).breakOverMinutes).toBe(12);
    expect(line(run(over), 'Break overrun')).toBeUndefined();
  });

  it('takes rupees for each minute over', () => {
    expect(line(run(over, { policy: { breakOverrunPerMinute: 2.5 } }), 'Break overrun')?.amount).toBe(30);
  });
});

describe('the pay of one day', () => {
  it('uses calendar days when the company says so', () => {
    const days = month((d, i) => { if (i === 1) d.attendance = undefined; });
    const r = run(days, { policy: { workingDaysBasis: 'calendar' } });
    expect(r.basisDays).toBe(30);
    expect(r.dailyRate).toBe(1000);
    expect(line(r, 'Absent without leave')?.amount).toBe(1000);
  });

  it('does not divide by zero in a month with no working days', () => {
    const r = run(month((d) => { d.isWorking = false; d.attendance = undefined; }));
    expect(r.dailyRate).toBe(0);
    expect(r.net).toBe(30000);
  });
});

describe('someone who joined during the month', () => {
  it('does not pay the days before they joined', () => {
    const days = month((d, i) => { if (i < 10) { d.beforeJoining = true; d.attendance = undefined; } });
    const r = run(days);
    // days 1 to 10 of September 2026 include one Sunday (6 Sep), so nine of them are working days
    expect(line(r, 'Before joining date')?.amount).toBe(10384.62);
    expect(r.absentDays).toBe(0);
  });
});

describe('money', () => {
  it('works in paise, so the totals always add up', () => {
    const r = run(month((d, i) => { if (i % 5 === 1) d.attendance = undefined; }), { structure: { basePay: 33333.33, allowances: [{ label: 'A', amount: 0.1 }, { label: 'B', amount: 0.2 }], deductions: [] } });
    const earn = r.lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + Math.round(l.amount * 100), 0);
    const cut = r.lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + Math.round(l.amount * 100), 0);
    expect(Math.round(r.gross * 100)).toBe(earn);
    expect(Math.round(r.deductions * 100)).toBe(cut);
    expect(Math.round(r.net * 100)).toBe(earn - cut);
  });
});

describe('monthDays', () => {
  it('lists the dates of a month with their weekday', () => {
    const d = monthDays('2026-02');
    expect(d).toHaveLength(28);
    expect(d[0]).toEqual({ date: '2026-02-01', weekday: 0 });
    expect(monthDays('2028-02')).toHaveLength(29);
  });
});
