import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string): string => require.resolve(`${pkg}/files/${file}`);

const LATIN = { regular: font('@fontsource/noto-sans', 'noto-sans-latin-400-normal.woff'), bold: font('@fontsource/noto-sans', 'noto-sans-latin-700-normal.woff') };
const DEVANAGARI = {
  regular: font('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-400-normal.woff'),
  bold: font('@fontsource/noto-sans-devanagari', 'noto-sans-devanagari-devanagari-700-normal.woff'),
};

export interface PayslipData {
  company: string;
  employee: { name: string; email: string; role: string };
  /** YYYY-MM */
  month: string;
  basePay: number;
  allowances: number;
  deductions: number;
  netPay: number;
  notes: string | null;
  /** The lines of a payslip that came from a payroll run. When present they are printed instead of the three totals. */
  lines?: { kind: 'earning' | 'deduction'; label: string; amount: number; note?: string | null }[];
}

const inr = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const hasDevanagari = (s: string) => /[ऀ-ॿ]/.test(s);

export type PayslipRow =
  | { kind: 'row'; label: string; value: string; bold?: boolean; note?: string | null }
  | { kind: 'heading'; label: string }
  | { kind: 'rule' }
  | { kind: 'gap' };

/** What is printed between the two rules, in order. Kept apart from the drawing so it can be tested without reading a PDF. */
export function payslipRows(d: PayslipData): PayslipRow[] {
  const out: PayslipRow[] = [];
  if (d.lines) {
    for (const kind of ['earning', 'deduction'] as const) {
      out.push({ kind: 'heading', label: kind === 'earning' ? 'Earnings' : 'Deductions' });
      for (const l of d.lines.filter((x) => x.kind === kind)) out.push({ kind: 'row', label: l.label, value: `${kind === 'deduction' ? '- ' : ''}${inr(l.amount)}`, note: l.note });
      out.push({ kind: 'gap' });
    }
  } else {
    out.push({ kind: 'row', label: 'Base pay', value: inr(d.basePay) }, { kind: 'row', label: 'Allowances', value: inr(d.allowances) }, { kind: 'row', label: 'Deductions', value: `- ${inr(d.deductions)}` });
  }
  out.push({ kind: 'rule' }, { kind: 'row', label: 'Net pay', value: inr(d.netPay), bold: true }, { kind: 'rule' });
  return out;
}

/** A one-page payslip. Names in Hindi are drawn with a Devanagari font; everything else with Noto Sans. */
export function buildPayslip(d: PayslipData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${d.month}`, Author: d.company } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const text = (s: string, opts: { bold?: boolean; size?: number; x?: number; y?: number; width?: number; align?: 'left' | 'right' | 'center' } = {}) => {
    const set = hasDevanagari(s) ? DEVANAGARI : LATIN;
    doc.font(opts.bold ? set.bold : set.regular).fontSize(opts.size ?? 11);
    if (opts.x !== undefined && opts.y !== undefined) doc.text(s, opts.x, opts.y, { width: opts.width, align: opts.align });
    else doc.text(s, { align: opts.align });
  };

  text(d.company, { bold: true, size: 18 });
  text(`Payslip for ${monthName(d.month)}`, { size: 12 });
  doc.moveDown(1.5);
  text(`Employee: ${d.employee.name}`);
  text(`Email: ${d.employee.email}`);
  text(`Role: ${d.employee.role}`);
  doc.moveDown(1.5);

  const left = 50;
  const right = 545;
  let y = doc.y;
  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  for (const r of payslipRows(d)) {
    // A long structure (up to 40 lines) continues on a second page instead of running off the first.
    if (y > 690 && (r.kind === 'row' || r.kind === 'heading')) {
      doc.addPage();
      y = 50;
    }
    if (r.kind === 'rule') {
      y += 2;
      doc.moveTo(left, y).lineTo(right, y).stroke();
      y += 8;
    } else if (r.kind === 'heading') {
      text(r.label, { bold: true, x: left, y, width: 300 });
      y += 20;
    } else if (r.kind === 'gap') {
      y += 6;
    } else {
      text(r.label, { bold: r.bold, x: left, y, width: 300 });
      text(r.value, { bold: r.bold, x: 350, y, width: right - 350, align: 'right' });
      y += 22;
      if (r.note) {
        text(r.note, { size: 8, x: left + 12, y: y - 8, width: 330 });
        y += 8;
      }
    }
  }

  if (d.notes) {
    y += 16;
    text('Notes', { bold: true, x: left, y, width: right - left });
    text(d.notes, { x: left, y: y + 18, width: right - left });
  }
  // Kept inside the page margin: text that starts too low makes the PDF library open a second page.
  text(d.lines ? "Calculated by the CRM from the month's attendance and the salary structure, under the company's payroll policy." : 'Generated by the CRM from the salary record entered by the company.', { size: 8, x: left, y: 750, width: right - left });
  doc.end();
  return done;
}
