import { ApiError } from '@/lib/api';

export interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface Policy {
  workingDaysBasis: 'calendar' | 'working';
  lateFreePerMonth: number;
  latePenaltyDays: number;
  halfDayDeductionDays: number;
  absentDeductionDays: number;
  unpaidLeaveDeductionDays: number;
  breakOverrunPerMinute: number;
  effectiveFrom: string | null;
  isDefault: boolean;
}

export interface StructureLine {
  label: string;
  amount: number;
}

export interface Structure {
  id: string;
  user: Person;
  effectiveFrom: string;
  basePay: number;
  allowances: StructureLine[];
  deductions: StructureLine[];
  notes: string | null;
}

export interface RunSummary {
  id: string;
  month: string;
  status: 'draft' | 'approved';
  generatedAt: string;
  generatedBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  reopenedCount: number;
  people: number;
  gross: number;
  deductions: number;
  netPay: number;
}

export interface PayslipSummary {
  id: string;
  user: Person;
  gross: number;
  deductions: number;
  netPay: number;
  adjusted: boolean;
  presentDays: number;
  absentDays: number;
  lateCount: number;
}

export interface RunDetail extends RunSummary {
  payslips: PayslipSummary[];
  missingStructure: Person[];
}

export interface PayslipLine {
  id: string;
  kind: 'earning' | 'deduction';
  label: string;
  amount: number;
  calculated: number;
  source: 'structure' | 'attendance' | 'adjustment';
  detail: string | null;
  reason: string | null;
  adjustedBy: string | null;
}

export interface PayslipDetail extends PayslipSummary {
  month: string;
  run: { id: string; status: 'draft' | 'approved' };
  facts: { basisDays: number; workingDays: number; paidLeaveDays: number; unpaidLeaveDays: number; halfDays: number; breakOverMinutes: number; dailyRate: number };
  lines: PayslipLine[];
}

export const rupees = (n: number): string => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const monthName = (m: string): string => new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
export const errorText = (e: unknown): string => (e instanceof ApiError ? e.message : 'Cannot reach the server. Try again.');

/** The month before this one on the company's calendar, as YYYY-MM: the one payroll is run for. */
export function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toLocaleDateString('en-CA').slice(0, 7);
}

/** An amount typed in a box: a number with at most two decimals, or null when it is not one. */
export function parseMoney(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}
