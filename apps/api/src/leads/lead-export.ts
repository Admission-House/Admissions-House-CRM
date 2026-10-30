import writeXlsxFile from 'write-excel-file/node';
import { CSV_BOM, csvRow } from '../common/csv.js';

/** The most leads one file can hold. A larger selection must be narrowed with filters. */
export const MAX_EXPORT_ROWS = 20_000;

export interface ExportRow {
  lead_no: string;
  name: string;
  phone: string;
  email: string | null;
  status: string;
  queue: string;
  source: string;
  assigned_to: string | null;
  intent: string | null;
  study_mode: string | null;
  interest: string | null;
  next_followup: string | null;
  expected_closure: string | null;
  created: string;
  updated: string;
}

export const COLUMNS: { header: string; value: (r: ExportRow) => string }[] = [
  { header: 'Lead No', value: (r) => r.lead_no },
  { header: 'Name', value: (r) => r.name },
  { header: 'Phone', value: (r) => spacedPhone(r.phone) },
  { header: 'Email', value: (r) => r.email ?? '' },
  { header: 'Status', value: (r) => r.status },
  { header: 'Queue', value: (r) => r.queue },
  { header: 'Source', value: (r) => r.source },
  { header: 'Assigned To', value: (r) => r.assigned_to ?? 'Unassigned' },
  { header: 'Intent', value: (r) => r.intent ?? '' },
  { header: 'Study Mode', value: (r) => r.study_mode ?? '' },
  { header: 'Interest', value: (r) => r.interest ?? '' },
  { header: 'Next Follow-up', value: (r) => r.next_followup ?? '' },
  { header: 'Expected Closure', value: (r) => r.expected_closure ?? '' },
  { header: 'Created', value: (r) => r.created },
  { header: 'Last Updated', value: (r) => r.updated },
];

/**
 * 919876543210 becomes "91 98765 43210". A spreadsheet shows a bare 12-digit number as 9.19E+11 and
 * drops digits; with spaces it stays text, and the import reads it back as the same number.
 */
export function spacedPhone(phone: string): string {
  return /^91\d{10}$/.test(phone) ? `91 ${phone.slice(2, 7)} ${phone.slice(7)}` : phone;
}

export function toCsv(rows: readonly ExportRow[]): string {
  return CSV_BOM + csvRow(COLUMNS.map((c) => c.header)) + rows.map((r) => csvRow(COLUMNS.map((c) => c.value(r)))).join('');
}

export function toXlsx(rows: readonly ExportRow[]): Promise<Buffer> {
  const header = COLUMNS.map((c) => ({ value: c.header, fontWeight: 'bold' as const }));
  const body = rows.map((r) => COLUMNS.map((c) => ({ value: c.value(r), type: String })));
  return writeXlsxFile([header, ...body]).toBuffer();
}
