import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AttendanceSummaryService, MonthSummary } from '../attendance/attendance-summary.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { CSV_BOM, csvRow } from '../common/csv.js';
import { decodeCursor, Page, toPage } from '../common/pagination.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { readTable } from '../imports/spreadsheet.js';
import { amountProblem, monthLabel, monthStart, parseSalarySheet, SalaryProblem, SalaryRow } from './payroll-rules.js';
import { buildPayslip } from './payslip.js';

export interface SalaryInput {
  userId: string;
  month: string;
  basePay: number;
  allowances: number;
  deductions: number;
  notes?: string | null;
}

export interface SalaryView {
  id: string;
  user: { id: string; name: string; email: string; role: string };
  month: string;
  basePay: number;
  allowances: number;
  deductions: number;
  netPay: number;
  notes: string | null;
  enteredBy: string;
  updatedAt: Date;
}

interface Row {
  id: string; user_id: string; user_name: string; email: string; role: string; month: string; base_pay: string; allowances: string;
  deductions: string; net_pay: string; notes: string | null; entered_by: string; updated_at: Date; created_text: string;
}

const SELECT = sql`
  SELECT s.id, s.user_id, u.name AS user_name, u.email::text AS email, r.name AS role, s.month::text AS month, s.base_pay, s.allowances,
         s.deductions, s.net_pay, s.notes, e.name AS entered_by, s.updated_at, s.created_at::text AS created_text
  FROM salary_records s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id JOIN users e ON e.id = s.entered_by`;

const cursorShape = z.object({ m: z.string(), i: z.string() });

export interface ImportResult {
  month: string;
  rows: number;
  /** Rows that add a new record / change an existing one. */
  toAdd: number;
  toChange: number;
  problems: SalaryProblem[];
  applied: boolean;
  batchId?: string;
}

/**
 * Salaries are entered by people, not calculated: net pay is base pay plus allowances minus
 * deductions, and attendance is shown beside it for reference only. A person sees their own records;
 * an Admin sees their team's; nobody sees records outside their reach (a 404, so their existence is
 * not revealed). Every change is written to the audit log with the old and new amounts.
 */
@Injectable()
export class PayrollService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly summary: AttendanceSummaryService,
  ) {}

  // ----------------------------------------------------------------- write

  save(auth: AuthContext, input: SalaryInput): Promise<SalaryView> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const id = await this.upsert(trx, auth, this.checked(input), null);
      return this.view(trx, id);
    });
  }

  /** Several employees for one month, all together or none. */
  saveMany(auth: AuthContext, month: string, rows: Omit<SalaryInput, 'month'>[]): Promise<{ saved: SalaryView[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const problems: { index: number; problem: string }[] = [];
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const [index, r] of rows.entries()) {
        try {
          if (seen.has(r.userId)) throw AppError.badRequest('DUPLICATE_ROW', 'This employee appears more than once');
          seen.add(r.userId);
          ids.push(await this.upsert(trx, auth, this.checked({ ...r, month }), null));
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          problems.push({ index, problem: err.message });
        }
      }
      if (problems.length > 0) throw new AppError('BULK_REJECTED', 'Some rows cannot be saved, so none were', 422, undefined, undefined, { problems });
      return { saved: await Promise.all(ids.map((id) => this.view(trx, id))) };
    });
  }

  private checked(input: SalaryInput): SalaryInput & { monthDate: string } {
    const monthDate = monthStart(input.month);
    if (!monthDate) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    if (monthDate > new Date().toISOString().slice(0, 7) + '-01') {
      throw AppError.badRequest('MONTH_IN_FUTURE', 'A salary cannot be entered for a month that has not begun', [{ field: 'month', message: 'Choose this month or an earlier one' }]);
    }
    const bad = amountProblem(input);
    if (bad) throw new AppError('NET_NEGATIVE', bad, 422, [{ field: 'deductions', message: bad }]);
    return { ...input, monthDate };
  }

  /** Adds or changes one record, with the audit entry. Returns the record's id. */
  private async upsert(trx: Trx, auth: AuthContext, input: SalaryInput & { monthDate: string }, batchId: string | null): Promise<string> {
    if (input.userId === auth.userId) throw new AppError('OWN_SALARY', 'You cannot enter your own salary. Ask another admin.', 403);
    const scoped = scopeCondition(auth, 'u.id');
    const { rows: target } = await sql<{ id: string }>`SELECT u.id FROM users u WHERE u.id = ${input.userId}::uuid ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!target[0]) throw AppError.notFound('Employee');

    const { rows: before } = await sql<{ id: string; base_pay: string; allowances: string; deductions: string; notes: string | null }>`
      SELECT id, base_pay, allowances, deductions, notes FROM salary_records WHERE user_id = ${input.userId}::uuid AND month = ${input.monthDate}::date FOR UPDATE`.execute(trx);
    const notes = input.notes?.trim() || null;
    let id: string;
    if (before[0]) {
      id = before[0].id;
      await sql`
        UPDATE salary_records SET base_pay = ${input.basePay}, allowances = ${input.allowances}, deductions = ${input.deductions}, notes = ${notes},
               entered_by = ${auth.userId}, updated_at = now(), batch_id = ${batchId}
        WHERE id = ${id}::uuid`.execute(trx);
    } else {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO salary_records (tenant_id, user_id, month, base_pay, allowances, deductions, notes, entered_by, batch_id)
        VALUES (${auth.tenantId}, ${input.userId}, ${input.monthDate}, ${input.basePay}, ${input.allowances}, ${input.deductions}, ${notes}, ${auth.userId}, ${batchId})
        RETURNING id`.execute(trx);
      id = rows[0]!.id;
    }
    await this.audit.write(trx, {
      tenantId: auth.tenantId, actorId: auth.userId, action: before[0] ? 'salary.update' : 'salary.create', entity: 'salary_record', entityId: id,
      before: before[0] && { basePay: Number(before[0].base_pay), allowances: Number(before[0].allowances), deductions: Number(before[0].deductions), notes: before[0].notes },
      after: { userId: input.userId, month: monthLabel(input.monthDate), basePay: input.basePay, allowances: input.allowances, deductions: input.deductions, notes },
      ip: auth.ip, requestId: auth.requestId,
    });
    return id;
  }

  // ---------------------------------------------------------------- import

  /** Reads a salary sheet for one month. With `apply`, saves the good rows and keeps a record of the upload. */
  async importSheet(auth: AuthContext, input: { month: string; fileName: string; data: Buffer }, apply: boolean): Promise<ImportResult> {
    const monthDate = monthStart(input.month);
    if (!monthDate) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    this.checked({ userId: auth.userId, month: input.month, basePay: 0, allowances: 0, deductions: 0 });
    const table = await readTable(input.data);
    const parsed = parseSalarySheet(table);
    if (parsed.missing.length > 0) {
      throw new AppError('MAPPING_INCOMPLETE', `The sheet needs columns for: ${parsed.missing.join(', ')}`, 422, undefined, undefined, { missing: parsed.missing, columns: table.header });
    }

    return this.db.withTenant(auth.tenantId, async (trx) => {
      const problems = [...parsed.problems];
      const good: (SalaryRow & { userId: string })[] = [];
      const seen = new Set<string>();
      for (const r of parsed.rows) {
        if (seen.has(r.email)) {
          problems.push({ row: r.row, email: r.email, problem: 'This employee appears more than once in the file' });
          continue;
        }
        seen.add(r.email);
        const scoped = scopeCondition(auth, 'u.id');
        const { rows } = await sql<{ id: string }>`SELECT u.id FROM users u WHERE u.email = ${r.email} ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
        if (!rows[0]) problems.push({ row: r.row, email: r.email, problem: 'email: No employee with this email in your team' });
        else if (rows[0].id === auth.userId) problems.push({ row: r.row, email: r.email, problem: 'email: You cannot enter your own salary' });
        else good.push({ ...r, userId: rows[0].id });
      }
      const { rows: existing } = good.length
        ? await sql<{ user_id: string }>`SELECT user_id FROM salary_records WHERE month = ${monthDate}::date AND user_id = ANY(${good.map((g) => g.userId)}::uuid[])`.execute(trx)
        : { rows: [] };
      const result: ImportResult = {
        month: monthLabel(monthDate), rows: parsed.rows.length + parsed.problems.length, toAdd: good.length - existing.length, toChange: existing.length,
        problems: problems.sort((a, b) => a.row - b.row), applied: apply,
      };
      if (!apply) return result;

      const { rows: batch } = await sql<{ id: string }>`
        INSERT INTO salary_import_batches (tenant_id, month, uploaded_by, rows_total, rows_ok, rows_failed)
        VALUES (${auth.tenantId}, ${monthDate}, ${auth.userId}, ${result.rows}, ${good.length}, ${problems.length}) RETURNING id`.execute(trx);
      for (const g of good) {
        await this.upsert(trx, auth, { userId: g.userId, month: input.month, monthDate, basePay: g.basePay, allowances: g.allowances, deductions: g.deductions, notes: g.notes }, batch[0]!.id);
      }
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'salary.import', entity: 'salary_import_batch', entityId: batch[0]!.id,
        after: { file: input.fileName, month: result.month, saved: good.length, skipped: problems.length }, ip: auth.ip, requestId: auth.requestId,
      });
      return { ...result, batchId: batch[0]!.id };
    });
  }

  // ------------------------------------------------------------------ read

  list(auth: AuthContext, q: { month?: string; userId?: string; roleId?: string; limit: number; cursor?: string }): Promise<Page<SalaryView>> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const after = decodeCursor(q.cursor, cursorShape);
      const c: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`true`];
      const scoped = scopeCondition(auth, 's.user_id');
      if (scoped) c.push(scoped as never);
      if (q.month) c.push(sql<SqlBool>`s.month = ${this.month(q.month)}::date`);
      if (q.userId) c.push(sql<SqlBool>`s.user_id = ${q.userId}::uuid`);
      if (q.roleId) c.push(sql<SqlBool>`u.role_id = ${q.roleId}::uuid`);
      if (after) c.push(sql<SqlBool>`(s.month, s.id) < (${after.m}::date, ${after.i}::uuid)`);
      const { rows } = await sql<Row>`${SELECT} WHERE ${sql.join(c, sql` AND `)} ORDER BY s.month DESC, s.id DESC LIMIT ${q.limit + 1}`.execute(trx);
      const page = toPage(rows, q.limit, (last) => ({ m: last.month, i: last.id }));
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  mine(auth: AuthContext): Promise<SalaryView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows } = await sql<Row>`${SELECT} WHERE s.user_id = ${auth.userId}::uuid ORDER BY s.month DESC LIMIT 60`.execute(trx);
      return rows.map(toView);
    });
  }

  /** One record with the month's attendance beside it (for reference; it does not change the amount). */
  detail(auth: AuthContext, id: string): Promise<SalaryView & { attendance: MonthSummary | null }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await this.reachable(trx, auth, id);
      const attendance = (await this.summary.forMonth(trx, [row.user_id], row.month)).get(row.user_id) ?? null;
      return { ...toView(row), attendance };
    });
  }

  /** The monthly report as a file. */
  async report(auth: AuthContext, q: { month?: string; userId?: string; roleId?: string; format: 'csv' | 'xlsx' }) {
    const all: SalaryView[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(auth, { ...q, limit: 100, cursor });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && all.length < 20_000);
    const header = ['Month', 'Employee', 'Email', 'Role', 'Base Pay', 'Allowances', 'Deductions', 'Net Pay', 'Notes'];
    const lines = all.map((s) => [s.month, s.user.name, s.user.email, s.user.role, s.basePay, s.allowances, s.deductions, s.netPay, s.notes ?? '']);
    const stamp = q.month ?? 'all';
    if (q.format === 'csv') return { fileName: `salaries-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: CSV_BOM + csvRow(header) + lines.map(csvRow).join('') };
    const { default: writeXlsxFile } = await import('write-excel-file/node');
    const cell = (v: string | number) => (typeof v === 'number' ? { value: v, format: '#,##0.00' } : { value: v, type: String });
    const body = await writeXlsxFile([header.map((h) => ({ value: h, fontWeight: 'bold' as const })), ...lines.map((l) => l.map(cell))] as never).toBuffer();
    return { fileName: `salaries-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body };
  }

  async payslip(auth: AuthContext, id: string): Promise<{ fileName: string; pdf: Buffer }> {
    const { row, company } = await this.db.withTenant(auth.tenantId, async (trx) => ({
      row: await this.reachable(trx, auth, id),
      company: (await sql<{ name: string }>`SELECT name FROM tenants LIMIT 1`.execute(trx)).rows[0]!.name,
    }));
    const pdf = await buildPayslip({
      company, employee: { name: row.user_name, email: row.email, role: row.role }, month: monthLabel(row.month),
      basePay: Number(row.base_pay), allowances: Number(row.allowances), deductions: Number(row.deductions), netPay: Number(row.net_pay), notes: row.notes,
    });
    return { fileName: `payslip-${monthLabel(row.month)}.pdf`, pdf };
  }

  // ----------------------------------------------------------------- inner

  private month(text: string): string {
    const m = monthStart(text);
    if (!m) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    return m;
  }

  /** A record the caller may see: their own, or one of someone in their reach with salary.read. */
  private async reachable(trx: Trx, auth: AuthContext, id: string): Promise<Row> {
    const own = sql<SqlBool>`s.user_id = ${auth.userId}::uuid`;
    let access = own;
    if (auth.permissions.has('salary.read')) {
      const scoped = scopeCondition(auth, 's.user_id');
      access = scoped ? sql<SqlBool>`(${own} OR ${scoped})` : sql<SqlBool>`true`;
    } else if (!auth.permissions.has('salary.read_own')) {
      throw AppError.forbidden();
    }
    const { rows } = await sql<Row>`${SELECT} WHERE s.id = ${id}::uuid AND ${access}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Salary record');
    return rows[0];
  }

  private async view(trx: Trx, id: string): Promise<SalaryView> {
    const { rows } = await sql<Row>`${SELECT} WHERE s.id = ${id}::uuid`.execute(trx);
    return toView(rows[0]!);
  }
}

function toView(r: Row): SalaryView {
  return {
    id: r.id, user: { id: r.user_id, name: r.user_name, email: r.email, role: r.role }, month: monthLabel(r.month), basePay: Number(r.base_pay),
    allowances: Number(r.allowances), deductions: Number(r.deductions), netPay: Number(r.net_pay), notes: r.notes, enteredBy: r.entered_by, updatedAt: r.updated_at,
  };
}

