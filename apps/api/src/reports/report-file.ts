import { CSV_BOM, csvRow } from '../common/csv.js';

export interface Column {
  key: string;
  label: string;
}

/** Every report has this shape, so one renderer serves the screen, CSV and Excel. */
export interface Report {
  title: string;
  /** The date range the report covers, when it has one. */
  from?: string;
  to?: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
}

export type ReportFormat = 'json' | 'csv' | 'xlsx';

export function toCsv(r: Report): string {
  return CSV_BOM + csvRow(r.columns.map((c) => c.label)) + r.rows.map((row) => csvRow(r.columns.map((c) => row[c.key] ?? ''))).join('');
}

export async function toXlsx(r: Report): Promise<Buffer> {
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const header = r.columns.map((c) => ({ value: c.label, fontWeight: 'bold' as const }));
  const body = r.rows.map((row) =>
    r.columns.map((c) => {
      const v = row[c.key] ?? '';
      return typeof v === 'number' ? { value: v } : { value: v, type: String };
    }),
  );
  return writeXlsxFile([header, ...body] as never).toBuffer();
}

export const fileName = (r: Report, ext: string) => `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}${r.from ? `-${r.from}-to-${r.to}` : ''}.${ext}`;
