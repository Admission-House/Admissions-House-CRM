import { parseAmount } from '../masters/master-import-rules.js';
import { normalizeHeader } from '../imports/import-rules.js';
import type { Table } from '../imports/spreadsheet.js';

/** "2026-10" becomes "2026-10-01"; anything else is refused. */
export function monthStart(text: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text.trim());
  return m && Number(m[1]) >= 2000 && Number(m[1]) <= 2100 ? `${m[1]}-${m[2]}-01` : null;
}

export const monthLabel = (date: string): string => date.slice(0, 7);

/** Money is two decimals at most; compare in paise so 0.1 + 0.2 style errors cannot creep in. */
export const paise = (n: number): number => Math.round(n * 100);

export interface SalaryInput {
  basePay: number;
  allowances: number;
  deductions: number;
}

/** The problem with a salary's amounts, if any. Net pay is base + allowances - deductions and cannot be negative. */
export function amountProblem(s: SalaryInput): string | null {
  if (paise(s.deductions) > paise(s.basePay) + paise(s.allowances)) return 'Deductions are more than base pay plus allowances';
  return null;
}

export const netPay = (s: SalaryInput): number => (paise(s.basePay) + paise(s.allowances) - paise(s.deductions)) / 100;

// ------------------------------------------------------------ spreadsheet

const FIELDS = ['email', 'basePay', 'allowances', 'deductions', 'notes'] as const;
type Field = (typeof FIELDS)[number];
const SYNONYMS: Record<Field, string[]> = {
  email: ['email', 'emailid', 'emailaddress', 'employeeemail', 'mail'],
  basePay: ['basepay', 'basic', 'basicpay', 'basicsalary', 'base', 'salary', 'basesalary'],
  allowances: ['allowances', 'allowance', 'additions', 'earnings'],
  deductions: ['deductions', 'deduction', 'less'],
  notes: ['notes', 'note', 'remarks', 'remark'],
};

export interface SalaryRow {
  row: number;
  email: string;
  basePay: number;
  allowances: number;
  deductions: number;
  notes?: string;
}
export interface SalaryProblem {
  row: number;
  email?: string;
  problem: string;
}

/** Reads a salary sheet: one row per employee, found by email. Amounts may be typed as ₹1,25,000. */
export function parseSalarySheet(table: Table): { rows: SalaryRow[]; problems: SalaryProblem[]; missing: Field[] } {
  const at: Partial<Record<Field, number>> = {};
  for (const f of FIELDS) {
    const wanted = SYNONYMS[f].map(normalizeHeader);
    const i = table.header.findIndex((h, idx) => !Object.values(at).includes(idx) && wanted.includes(normalizeHeader(h)));
    if (i >= 0) at[f] = i;
  }
  const missing = (['email', 'basePay'] as const).filter((f) => at[f] === undefined);
  const rows: SalaryRow[] = [];
  const problems: SalaryProblem[] = [];
  if (missing.length > 0) return { rows, problems, missing };

  table.rows.forEach((cells, i) => {
    const row = i + 2;
    const get = (f: Field) => (at[f] === undefined ? '' : (cells[at[f]!] ?? '').trim());
    if (FIELDS.every((f) => get(f) === '')) return;
    const email = get('email').toLowerCase();
    const fail: string[] = [];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail.push('email: Not a valid email address');
    const base = parseAmount(get('basePay'));
    const allow = parseAmount(get('allowances'));
    const ded = parseAmount(get('deductions'));
    if (base === undefined || base === null) fail.push('basePay: Give the base pay as an amount');
    if (allow === undefined) fail.push('allowances: Not a valid amount');
    if (ded === undefined) fail.push('deductions: Not a valid amount');
    if (fail.length === 0) {
      const s = { basePay: base!, allowances: allow ?? 0, deductions: ded ?? 0 };
      const bad = amountProblem(s);
      if (bad) fail.push(`deductions: ${bad}`);
      else rows.push({ row, email, ...s, notes: get('notes').slice(0, 500) || undefined });
      if (!bad) return;
    }
    problems.push({ row, email: email || undefined, problem: fail.join('; ') });
  });
  return { rows, problems, missing };
}
