import { amountProblem, monthStart, netPay, parseSalarySheet } from './payroll-rules.js';

describe('monthStart', () => {
  it.each([['2026-10', '2026-10-01'], ['2000-01', '2000-01-01'], [' 2026-12 ', '2026-12-01']])('reads %j', (t, d) => expect(monthStart(t)).toBe(d));
  it.each([['2026-13'], ['2026-00'], ['2026-1'], ['26-10'], ['1999-12'], ['2101-01'], ['October'], ['']])('refuses %j', (t) => expect(monthStart(t)).toBeNull());
});

describe('amounts', () => {
  it('adds without floating point drift', () => {
    expect(netPay({ basePay: 0.1, allowances: 0.2, deductions: 0 })).toBe(0.3);
    expect(netPay({ basePay: 30000, allowances: 2500.5, deductions: 1200.25 })).toBe(31300.25);
  });
  it('refuses deductions larger than what is earned, and allows exactly equal', () => {
    expect(amountProblem({ basePay: 1000, allowances: 0, deductions: 1000.01 })).not.toBeNull();
    expect(amountProblem({ basePay: 1000, allowances: 500, deductions: 1500 })).toBeNull();
  });
});

describe('parseSalarySheet', () => {
  const table = (header: string[], ...rows: string[][]) => ({ header, rows });

  it('reads rows found by email, with amounts as people type them', () => {
    const t = table(['Employee Email', 'Basic Salary', 'Allowance', 'Deductions', 'Remarks'], ['Riya@Example.com', '₹ 30,000', '2,500', '', 'Bonus']);
    expect(parseSalarySheet(t)).toMatchObject({ missing: [], problems: [], rows: [{ row: 2, email: 'riya@example.com', basePay: 30000, allowances: 2500, deductions: 0, notes: 'Bonus' }] });
  });

  it('says which columns are missing', () => {
    expect(parseSalarySheet(table(['Name', 'Pay'], ['a', '1'])).missing).toEqual(['email', 'basePay']);
  });

  it('reports each bad row with its reasons and skips blank rows', () => {
    const t = table(['Email', 'Base Pay', 'Deductions'], ['bad', 'x', ''], ['', '', ''], ['ok@example.com', '1000', '2000'], ['fine@example.com', '1000', '100']);
    const { rows, problems } = parseSalarySheet(t);
    expect(rows.map((r) => r.row)).toEqual([5]);
    expect(problems.map((p) => p.row)).toEqual([2, 4]);
    expect(problems[0]!.problem).toContain('email');
    expect(problems[0]!.problem).toContain('basePay');
    expect(problems[1]!.problem).toContain('more than base pay');
  });
});
