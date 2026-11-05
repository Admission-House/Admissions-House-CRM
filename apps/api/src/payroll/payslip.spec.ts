import { describe, expect, it } from 'vitest';
import { buildPayslip, PayslipData, payslipRows } from './payslip.js';

const base: PayslipData = {
  company: 'Acme Admissions',
  employee: { name: 'Rahul Mehta', email: 'rahul@example.test', role: 'Counsellor' },
  month: '2026-10',
  basePay: 27000,
  allowances: 5400,
  deductions: 2300,
  netPay: 30100,
  notes: null,
};

const withLines: PayslipData = {
  ...base,
  lines: [
    { kind: 'earning', label: 'Base pay', amount: 27000 },
    { kind: 'earning', label: 'HRA', amount: 5400 },
    { kind: 'deduction', label: 'PF', amount: 1800 },
    { kind: 'deduction', label: 'Late arrivals', amount: 500, note: '5 late arrivals, 3 free' },
  ],
};

/** The number of pages in a PDF made by pdfkit: every page is a plain /Type /Page object (page lists are /Pages). */
const pagesOf = (pdf: Buffer): number => (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

describe('what a payslip prints', () => {
  it('always ends with the net pay between two rules, whatever the layout', () => {
    for (const d of [base, withLines]) {
      const rows = payslipRows(d);
      expect(rows.slice(-3)).toEqual([{ kind: 'rule' }, { kind: 'row', label: 'Net pay', value: 'Rs. 30,100.00', bold: true }, { kind: 'rule' }]);
    }
  });

  it('shows three totals for a salary that was typed in', () => {
    const labels = payslipRows(base).filter((r) => r.kind === 'row').map((r) => (r as { label: string }).label);
    expect(labels).toEqual(['Base pay', 'Allowances', 'Deductions', 'Net pay']);
  });

  it('lists every earning and deduction of a calculated payslip, with the reason beside a line', () => {
    const rows = payslipRows(withLines);
    const text = rows.map((r) => (r.kind === 'row' ? `${r.label}=${r.value}${r.note ? ` (${r.note})` : ''}` : r.kind === 'heading' ? `[${r.label}]` : '')).filter(Boolean);
    expect(text).toEqual([
      '[Earnings]', 'Base pay=Rs. 27,000.00', 'HRA=Rs. 5,400.00',
      '[Deductions]', 'PF=- Rs. 1,800.00', 'Late arrivals=- Rs. 500.00 (5 late arrivals, 3 free)',
      'Net pay=Rs. 30,100.00',
    ]);
  });
});

describe('the payslip file', () => {
  it('is one page for an ordinary payslip', async () => {
    const pdf = await buildPayslip(withLines);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pagesOf(pdf)).toBe(1);
    expect(pagesOf(await buildPayslip(base))).toBe(1);
  });

  it('carries on to a second page for a very long structure instead of running off the first', async () => {
    const many = { ...withLines, lines: Array.from({ length: 40 }, (_, i) => ({ kind: (i < 20 ? 'earning' : 'deduction') as 'earning' | 'deduction', label: `Line ${i + 1}`, amount: 100 + i })) };
    const pages = pagesOf(await buildPayslip(many));
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(pages).toBeLessThanOrEqual(3);
  });
});
