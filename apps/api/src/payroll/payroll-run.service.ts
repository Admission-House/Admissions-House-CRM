import { Injectable } from '@nestjs/common';
import { sql, SqlBool } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import { calculatePayslip, PayrollPolicy, PayslipResult, toPaise, toRupees } from './payroll-calc.js';
import { PayrollFactsService } from './payroll-facts.service.js';
import { PayrollPolicyService } from './payroll-policy.service.js';
import { monthLabel, monthStart } from './payroll-rules.js';
import { SalaryStructureService } from './salary-structure.service.js';

const money = z.number().min(0).max(99_999_999).multipleOf(0.01);
const reason = z.string().trim().min(3, 'Say why, in a few words').max(300);

export const changeLineSchema = z.object({ amount: money, reason });
export const addLineSchema = z.object({ kind: z.enum(['earning', 'deduction']), label: z.string().trim().min(1).max(80), amount: money.refine((n) => n > 0, 'Enter an amount above 0'), reason });
export const reopenSchema = z.object({ reason });
export const recalculateSchema = z.object({ discardAdjustments: z.boolean().default(false) });

interface PersonRow { id: string; name: string; email: string; role: string }
export interface PayslipSummary {
  id: string;
  user: PersonRow;
  gross: number;
  deductions: number;
  netPay: number;
  adjusted: boolean;
  presentDays: number;
  absentDays: number;
  lateCount: number;
}
export interface PayslipLineView {
  id: string;
  kind: 'earning' | 'deduction';
  label: string;
  amount: number;
  calculated: number;
  source: 'structure' | 'attendance' | 'adjustment';
  detail: string | null;
  reason: string | null;
  adjustedBy: string | null;
  adjustedAt: Date | null;
}
export interface PayslipDetail extends PayslipSummary {
  month: string;
  run: { id: string; status: 'draft' | 'approved' };
  facts: { basisDays: number; workingDays: number; paidLeaveDays: number; unpaidLeaveDays: number; halfDays: number; breakOverMinutes: number; dailyRate: number };
  lines: PayslipLineView[];
}
export interface RunSummary {
  id: string;
  month: string;
  status: 'draft' | 'approved';
  generatedAt: Date;
  generatedBy: string;
  approvedAt: Date | null;
  approvedBy: string | null;
  reopenedCount: number;
  policy: PayrollPolicy;
  people: number;
  gross: number;
  deductions: number;
  netPay: number;
}

interface RunRow {
  id: string; month: string; status: 'draft' | 'approved'; generated_at: Date; generated_by: string; approved_at: Date | null; approved_by: string | null;
  reopened_count: number; policy: PayrollPolicy; people: number; gross: string; deductions: string; net: string;
}
interface PayslipRow {
  id: string; user_id: string; user_name: string; email: string; role: string; month: string; run_id: string; run_status: 'draft' | 'approved';
  basis_days: string; working_days: string; present_days: string; paid_leave_days: string; unpaid_leave_days: string; absent_days: string; half_days: string;
  late_count: number; break_over_minutes: number; daily_rate: string; gross: string; deductions: string; net_pay: string; adjusted: boolean;
}

const RUN_SELECT = sql`
  SELECT r.id, r.month::text AS month, r.status, r.generated_at, g.name AS generated_by, r.approved_at, a.name AS approved_by, r.reopened_count, r.policy,
         count(p.id)::int AS people, coalesce(sum(p.gross), 0) AS gross, coalesce(sum(p.deductions), 0) AS deductions, coalesce(sum(p.net_pay), 0) AS net
  FROM payroll_runs r JOIN users g ON g.id = r.generated_by LEFT JOIN users a ON a.id = r.approved_by`;

const PAYSLIP_SELECT = sql`
  SELECT p.id, p.user_id, u.name AS user_name, u.email::text AS email, ro.name AS role, p.month::text AS month, p.run_id, run.status AS run_status,
         p.basis_days, p.working_days, p.present_days, p.paid_leave_days, p.unpaid_leave_days, p.absent_days, p.half_days, p.late_count, p.break_over_minutes,
         p.daily_rate, p.gross, p.deductions, p.net_pay, p.adjusted
  FROM payslips p JOIN payroll_runs run ON run.id = p.run_id JOIN users u ON u.id = p.user_id JOIN roles ro ON ro.id = u.role_id`;

/**
 * The monthly payroll run: it calculates a payslip for everyone who has a salary structure, from the
 * structure, the attendance, the leaves and the breaks of the month, under the policy in force. People
 * with the right can adjust a line (always with a reason) while the run is a draft; the Super Admin
 * approves it. An approved run is locked by the database itself, and reopening it is the only way
 * to change it, and is logged.
 */
@Injectable()
export class PayrollRunService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly policies: PayrollPolicyService,
    private readonly structures: SalaryStructureService,
    private readonly facts: PayrollFactsService,
  ) {}

  // ------------------------------------------------------------- create

  /** Calculates the month for everyone and saves it as a draft. Only a finished month can be run, and only once. */
  create(auth: AuthContext, monthText: string): Promise<RunDetail> {
    const monthDate = this.month(monthText);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.assertFinished(trx, auth, monthDate);
      const { rows: existing } = await sql<{ id: string }>`SELECT id FROM payroll_runs WHERE month = ${monthDate}::date`.execute(trx);
      if (existing[0]) throw AppError.conflict('RUN_EXISTS', `A payroll run for ${monthLabel(monthDate)} already exists`, { runId: existing[0].id });

      const policy = await this.policies.effective(trx, monthDate);
      const { rows } = await sql<{ id: string }>`
        INSERT INTO payroll_runs (tenant_id, month, policy, generated_by) VALUES (${auth.tenantId}, ${monthDate}, ${JSON.stringify(stripView(policy))}::jsonb, ${auth.userId})
        RETURNING id`.execute(trx);
      const runId = rows[0]!.id;
      const result = await this.calculateInto(trx, auth, runId, monthDate, policy, { keepAdjusted: false });
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.run_create', entity: 'payroll_run', entityId: runId,
        after: { month: monthLabel(monthDate), payslips: result.count, withoutStructure: result.missing.length }, ip: auth.ip, requestId: auth.requestId,
      });
      return this.detail(trx, auth, runId);
    });
  }

  /**
   * Calculates the draft again, for example after a salary structure or the policy changed. A payslip that
   * someone has adjusted is kept as it is, unless the caller says to discard adjustments.
   */
  recalculate(auth: AuthContext, runId: string, input: { discardAdjustments: boolean }): Promise<RunDetail & { keptAdjusted: number }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const run = await this.lockRun(trx, runId, 'update');
      this.assertDraft(run);
      const policy = await this.policies.effective(trx, run.month);
      await sql`UPDATE payroll_runs SET policy = ${JSON.stringify(stripView(policy))}::jsonb, generated_by = ${auth.userId}, generated_at = now() WHERE id = ${runId}::uuid`.execute(trx);
      const result = await this.calculateInto(trx, auth, runId, run.month, policy, { keepAdjusted: !input.discardAdjustments });
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.run_recalculate', entity: 'payroll_run', entityId: runId,
        after: { month: monthLabel(run.month), payslips: result.count, keptAdjusted: result.kept, discardedAdjustments: input.discardAdjustments }, ip: auth.ip, requestId: auth.requestId,
      });
      return { ...(await this.detail(trx, auth, runId)), keptAdjusted: result.kept };
    });
  }

  // --------------------------------------------------------------- read

  list(auth: AuthContext): Promise<RunSummary[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const scoped = scopeCondition(auth, 'p.user_id');
      // People only ever see payslips in their reach, and their own only once the run is approved.
      const { rows } = await sql<RunRow>`
        ${RUN_SELECT} LEFT JOIN payslips p ON p.run_id = r.id AND ${this.visible(auth, scoped)}
        GROUP BY r.id, g.name, a.name ORDER BY r.month DESC LIMIT 36`.execute(trx);
      return rows.map(toRunSummary);
    });
  }

  detailOf(auth: AuthContext, runId: string): Promise<RunDetail> {
    return this.db.withTenant(auth.tenantId, (trx) => this.detail(trx, auth, runId));
  }

  payslip(auth: AuthContext, payslipId: string): Promise<PayslipDetail> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await this.reachable(trx, auth, payslipId);
      return this.payslipDetail(trx, row);
    });
  }

  // ------------------------------------------------------------- adjust

  changeLine(auth: AuthContext, payslipId: string, lineId: string, input: z.infer<typeof changeLineSchema>): Promise<PayslipDetail> {
    return this.edit(auth, payslipId, async (trx, row) => {
      const { rows } = await sql<LineRow>`${LINE_SELECT} WHERE l.id = ${lineId}::uuid AND l.payslip_id = ${payslipId}::uuid FOR UPDATE OF l`.execute(trx);
      const line = rows[0];
      if (!line) throw AppError.notFound('Payslip line');
      const unchanged = toPaise(input.amount) === toPaise(Number(line.calculated));
      // Setting a line back to what the rules calculated clears the adjustment instead of recording a pointless one.
      await sql`
        UPDATE payslip_lines SET amount = ${input.amount},
               reason = ${unchanged ? null : input.reason}, adjusted_by = ${unchanged ? null : auth.userId}::uuid, adjusted_at = ${unchanged ? null : sql`now()`}
        WHERE id = ${lineId}::uuid`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.line_adjust', entity: 'payslip', entityId: payslipId,
        before: { line: line.label, amount: Number(line.amount) }, after: { line: line.label, amount: input.amount, reason: input.reason, employee: row.user_name, month: monthLabel(row.month) },
        ip: auth.ip, requestId: auth.requestId,
      });
    });
  }

  addLine(auth: AuthContext, payslipId: string, input: z.infer<typeof addLineSchema>): Promise<PayslipDetail> {
    return this.edit(auth, payslipId, async (trx, row) => {
      const { rows } = await sql<{ next: number }>`SELECT coalesce(max(position), -1) + 1 AS next FROM payslip_lines WHERE payslip_id = ${payslipId}::uuid`.execute(trx);
      await sql`
        INSERT INTO payslip_lines (tenant_id, payslip_id, kind, label, amount, calculated, source, reason, adjusted_by, adjusted_at, position)
        VALUES (${auth.tenantId}, ${payslipId}, ${input.kind}, ${input.label}, ${input.amount}, 0, 'adjustment', ${input.reason}, ${auth.userId}, now(), ${rows[0]!.next})`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.line_add', entity: 'payslip', entityId: payslipId,
        after: { kind: input.kind, label: input.label, amount: input.amount, reason: input.reason, employee: row.user_name, month: monthLabel(row.month) }, ip: auth.ip, requestId: auth.requestId,
      });
    });
  }

  /** Only a line that someone added can be removed; a calculated line can be set to 0 with a reason instead. */
  removeLine(auth: AuthContext, payslipId: string, lineId: string): Promise<PayslipDetail> {
    return this.edit(auth, payslipId, async (trx, row) => {
      const { rows } = await sql<LineRow>`${LINE_SELECT} WHERE l.id = ${lineId}::uuid AND l.payslip_id = ${payslipId}::uuid FOR UPDATE OF l`.execute(trx);
      const line = rows[0];
      if (!line) throw AppError.notFound('Payslip line');
      if (line.source !== 'adjustment') throw AppError.conflict('LINE_NOT_REMOVABLE', 'A calculated line cannot be removed. Set its amount to 0 and give a reason instead.');
      await sql`DELETE FROM payslip_lines WHERE id = ${lineId}::uuid`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.line_remove', entity: 'payslip', entityId: payslipId,
        before: { kind: line.kind, label: line.label, amount: Number(line.amount), reason: line.reason, employee: row.user_name, month: monthLabel(row.month) }, ip: auth.ip, requestId: auth.requestId,
      });
    });
  }

  // ---------------------------------------------------- approve, reopen

  /** Locks the run and copies each payslip into the salary records that My salary, the report and the PDF read. */
  approve(auth: AuthContext, runId: string): Promise<RunDetail> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const run = await this.lockRun(trx, runId, 'update');
      this.assertDraft(run);
      const { rows: slips } = await sql<PayslipRow>`
        ${PAYSLIP_SELECT}
        WHERE p.run_id = ${runId}::uuid ORDER BY u.name`.execute(trx);
      if (slips.length === 0) throw AppError.conflict('RUN_EMPTY', 'This run has no payslips. Give people a salary structure and calculate again.');
      const negative = slips.filter((s) => toPaise(Number(s.net_pay)) < 0);
      if (negative.length > 0) {
        throw new AppError('NET_NEGATIVE', `${negative.length} payslip${negative.length === 1 ? '' : 's'} would pay less than zero. Adjust them first.`, 422, undefined, undefined, { people: negative.map((s) => s.user_name) });
      }
      let overwritten = 0;
      for (const s of slips) {
        const { rows: base } = await sql<{ amount: string }>`SELECT amount FROM payslip_lines WHERE payslip_id = ${s.id}::uuid AND label = 'Base pay' AND source = 'structure' LIMIT 1`.execute(trx);
        const basePay = Number(base[0]?.amount ?? 0);
        const gross = Number(s.gross);
        const { rows: had } = await sql<{ payslip_id: string | null }>`SELECT payslip_id FROM salary_records WHERE user_id = ${s.user_id}::uuid AND month = ${run.month}::date`.execute(trx);
        if (had[0] && had[0].payslip_id === null) overwritten += 1;
        await sql`
          INSERT INTO salary_records (tenant_id, user_id, month, base_pay, allowances, deductions, notes, entered_by, payslip_id, is_live)
          VALUES (${auth.tenantId}, ${s.user_id}, ${run.month}, ${basePay}, ${toRupees(toPaise(gross) - toPaise(basePay))}, ${Number(s.deductions)},
                  ${`Payroll run for ${monthLabel(run.month)}`}, ${auth.userId}, ${s.id}, true)
          ON CONFLICT (user_id, month) DO UPDATE SET base_pay = EXCLUDED.base_pay, allowances = EXCLUDED.allowances, deductions = EXCLUDED.deductions,
                 notes = EXCLUDED.notes, entered_by = EXCLUDED.entered_by, payslip_id = EXCLUDED.payslip_id, is_live = true, updated_at = now()`.execute(trx);
      }
      await sql`UPDATE payroll_runs SET status = 'approved', approved_by = ${auth.userId}, approved_at = now() WHERE id = ${runId}::uuid`.execute(trx);
      const totals = slips.reduce((t, s) => ({ gross: t.gross + toPaise(Number(s.gross)), deductions: t.deductions + toPaise(Number(s.deductions)) }), { gross: 0, deductions: 0 });
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.approve', entity: 'payroll_run', entityId: runId,
        after: { month: monthLabel(run.month), payslips: slips.length, gross: toRupees(totals.gross), deductions: toRupees(totals.deductions), net: toRupees(totals.gross - totals.deductions), replacedManualRecords: overwritten },
        ip: auth.ip, requestId: auth.requestId,
      });
      return this.detail(trx, auth, runId);
    });
  }

  /** Makes an approved run editable again. People stop seeing its payslips until it is approved again. */
  reopen(auth: AuthContext, runId: string, input: z.infer<typeof reopenSchema>): Promise<RunDetail> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const run = await this.lockRun(trx, runId, 'update');
      if (run.status !== 'approved') throw AppError.conflict('RUN_NOT_APPROVED', 'Only an approved run can be reopened');
      await sql`UPDATE payroll_runs SET status = 'draft', approved_by = NULL, approved_at = NULL, reopened_count = reopened_count + 1 WHERE id = ${runId}::uuid`.execute(trx);
      const hidden = await sql`UPDATE salary_records SET is_live = false, updated_at = now() WHERE payslip_id IN (SELECT id FROM payslips WHERE run_id = ${runId}::uuid)`.execute(trx);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.reopen', entity: 'payroll_run', entityId: runId,
        before: { status: 'approved', approvedAt: run.approvedAt }, after: { status: 'draft', month: monthLabel(run.month), reason: input.reason, hiddenSalaryRecords: Number(hidden.numAffectedRows ?? 0) },
        ip: auth.ip, requestId: auth.requestId,
      });
      return this.detail(trx, auth, runId);
    });
  }

  // ------------------------------------------------------------- inner

  /** Calculates the payslips of a run for everyone with a structure and writes them. */
  private async calculateInto(
    trx: Trx, auth: AuthContext, runId: string, monthDate: string, policy: PayrollPolicy, opt: { keepAdjusted: boolean },
  ): Promise<{ count: number; kept: number; missing: PersonRow[] }> {
    const { rows: people } = await sql<PersonRow & { status: string }>`
      SELECT u.id, u.name, u.email::text AS email, r.name AS role, u.status FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active' OR EXISTS (SELECT 1 FROM attendance_records a WHERE a.user_id = u.id AND a.work_date >= ${monthDate}::date AND a.work_date < (${monthDate}::date + interval '1 month')::date)
      ORDER BY u.name, u.id`.execute(trx);
    const ids = people.map((p) => p.id);
    const structures = await this.structures.inForce(trx, ids, monthDate);
    const month = await this.facts.forMonth(trx, ids, monthDate);

    const { rows: current } = await sql<{ id: string; user_id: string; adjusted: boolean }>`SELECT id, user_id, adjusted FROM payslips WHERE run_id = ${runId}::uuid`.execute(trx);
    const keep = new Set(opt.keepAdjusted ? current.filter((c) => c.adjusted).map((c) => c.user_id) : []);
    // Payslips that will be rebuilt are removed first (their lines go with them); the rows are written again below.
    const dropped = current.filter((c) => !keep.has(c.user_id)).map((c) => c.id);
    if (dropped.length > 0) await sql`DELETE FROM payslips WHERE id = ANY(${dropped}::uuid[])`.execute(trx);

    const missing: PersonRow[] = [];
    let count = 0;
    for (const p of people) {
      const structure = structures.get(p.id);
      if (!structure) {
        if (p.status === 'active') missing.push({ id: p.id, name: p.name, email: p.email, role: p.role });
        continue;
      }
      if (keep.has(p.id)) continue;
      const result = calculatePayslip({ policy, structure, days: month.days.get(p.id)!, calendarDays: month.calendarDays });
      await this.write(trx, auth, runId, p.id, monthDate, result);
      count += 1;
    }
    return { count, kept: keep.size, missing };
  }

  private async write(trx: Trx, auth: AuthContext, runId: string, userId: string, monthDate: string, r: PayslipResult): Promise<void> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO payslips (tenant_id, run_id, user_id, month, basis_days, working_days, present_days, paid_leave_days, unpaid_leave_days, absent_days, half_days,
                            late_count, break_over_minutes, daily_rate, gross, deductions)
      VALUES (${auth.tenantId}, ${runId}, ${userId}, ${monthDate}, ${r.basisDays}, ${r.workingDays}, ${r.presentDays}, ${r.paidLeaveDays}, ${r.unpaidLeaveDays}, ${r.absentDays},
              ${r.halfDays}, ${r.lateCount}, ${r.breakOverMinutes}, ${r.dailyRate}, ${r.gross}, ${r.deductions})
      RETURNING id`.execute(trx);
    for (const [position, l] of r.lines.entries()) {
      await sql`
        INSERT INTO payslip_lines (tenant_id, payslip_id, kind, label, amount, calculated, source, detail, position)
        VALUES (${auth.tenantId}, ${rows[0]!.id}, ${l.kind}, ${l.label}, ${l.amount}, ${l.amount}, ${l.source}, ${l.detail ?? null}, ${position})`.execute(trx);
    }
  }

  /** Runs an edit on a draft payslip the caller may change, then brings the payslip's totals back in step with its lines. */
  private edit(auth: AuthContext, payslipId: string, change: (trx: Trx, row: PayslipRow) => Promise<void>): Promise<PayslipDetail> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const row = await this.reachable(trx, auth, payslipId);
      if (row.user_id === auth.userId) throw new AppError('OWN_SALARY', 'You cannot adjust your own payslip. Ask another admin.', 403);
      const run = await this.lockRun(trx, row.run_id, 'share');
      this.assertDraft(run);
      await change(trx, row);
      await sql`
        UPDATE payslips SET
          gross = (SELECT coalesce(sum(amount), 0) FROM payslip_lines WHERE payslip_id = ${payslipId}::uuid AND kind = 'earning'),
          deductions = (SELECT coalesce(sum(amount), 0) FROM payslip_lines WHERE payslip_id = ${payslipId}::uuid AND kind = 'deduction'),
          adjusted = EXISTS (SELECT 1 FROM payslip_lines WHERE payslip_id = ${payslipId}::uuid AND (amount <> calculated OR source = 'adjustment'))
        WHERE id = ${payslipId}::uuid`.execute(trx);
      return this.payslipDetail(trx, await this.reachable(trx, auth, payslipId));
    });
  }

  private async detail(trx: Trx, auth: AuthContext, runId: string): Promise<RunDetail> {
    const scoped = scopeCondition(auth, 'p.user_id');
    const { rows } = await sql<RunRow>`
      ${RUN_SELECT} LEFT JOIN payslips p ON p.run_id = r.id AND ${this.visible(auth, scoped)}
      WHERE r.id = ${runId}::uuid GROUP BY r.id, g.name, a.name`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Payroll run');
    const { rows: slips } = await sql<PayslipRow>`${PAYSLIP_SELECT} WHERE p.run_id = ${runId}::uuid AND ${this.visible(auth, scoped)} ORDER BY u.name, u.id`.execute(trx);

    let missingStructure: PersonRow[] = [];
    if (rows[0].status === 'draft') {
      const scopedU = scopeCondition(auth, 'u.id');
      const month = rows[0].month;
      const { rows: people } = await sql<PersonRow>`
        SELECT u.id, u.name, u.email::text AS email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' ${scopedU ? sql`AND ${scopedU}` : sql``}
          AND NOT EXISTS (SELECT 1 FROM payslips p WHERE p.run_id = ${runId}::uuid AND p.user_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM salary_structures s WHERE s.user_id = u.id AND s.effective_from <= ${month}::date)
        ORDER BY u.name, u.id`.execute(trx);
      missingStructure = people;
    }
    return { ...toRunSummary(rows[0]), payslips: slips.map(toPayslipSummary), missingStructure };
  }

  private async payslipDetail(trx: Trx, row: PayslipRow): Promise<PayslipDetail> {
    const { rows } = await sql<LineRow>`${LINE_SELECT} WHERE l.payslip_id = ${row.id}::uuid ORDER BY l.position, l.id`.execute(trx);
    return {
      ...toPayslipSummary(row),
      month: monthLabel(row.month),
      run: { id: row.run_id, status: row.run_status },
      facts: {
        basisDays: Number(row.basis_days), workingDays: Number(row.working_days), paidLeaveDays: Number(row.paid_leave_days), unpaidLeaveDays: Number(row.unpaid_leave_days),
        halfDays: Number(row.half_days), breakOverMinutes: row.break_over_minutes, dailyRate: Number(row.daily_rate),
      },
      lines: rows.map(toLineView),
    };
  }

  /** Whether a payslip (alias p, with its run as `run`) can be seen: one's own only once approved, anyone else's within one's reach. */
  private visible(auth: AuthContext, scoped: ReturnType<typeof scopeCondition>) {
    const own = sql<SqlBool>`(p.user_id = ${auth.userId}::uuid AND EXISTS (SELECT 1 FROM payroll_runs x WHERE x.id = p.run_id AND x.status = 'approved'))`;
    if (!auth.permissions.has('salary.read')) return own;
    const others = scoped ? sql<SqlBool>`(p.user_id <> ${auth.userId}::uuid AND ${scoped})` : sql<SqlBool>`p.user_id <> ${auth.userId}::uuid`;
    return sql<SqlBool>`(${own} OR ${others})`;
  }

  private async reachable(trx: Trx, auth: AuthContext, payslipId: string): Promise<PayslipRow> {
    if (!auth.permissions.has('salary.read') && !auth.permissions.has('salary.read_own')) throw AppError.forbidden();
    const { rows } = await sql<PayslipRow>`${PAYSLIP_SELECT} WHERE p.id = ${payslipId}::uuid AND ${this.visible(auth, scopeCondition(auth, 'p.user_id'))}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Payslip');
    return rows[0];
  }

  /** Reads the run's row with a lock, so approving, reopening and adjusting cannot interleave. */
  private async lockRun(trx: Trx, runId: string, mode: 'update' | 'share'): Promise<{ id: string; month: string; status: 'draft' | 'approved'; approvedAt: Date | null }> {
    const { rows } = await sql<{ id: string; month: string; status: 'draft' | 'approved'; approved_at: Date | null }>`
      SELECT id, month::text AS month, status, approved_at FROM payroll_runs WHERE id = ${runId}::uuid ${mode === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Payroll run');
    return { id: rows[0].id, month: rows[0].month, status: rows[0].status, approvedAt: rows[0].approved_at };
  }

  private assertDraft(run: { status: string }): void {
    if (run.status !== 'draft') throw AppError.conflict('PAYROLL_APPROVED', 'This payroll is approved. Reopen it to change it.');
  }

  private async assertFinished(trx: Trx, auth: AuthContext, monthDate: string): Promise<void> {
    const { rows } = await sql<{ m: string }>`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM') AS m FROM tenants WHERE id = ${auth.tenantId}`.execute(trx);
    if (monthDate.slice(0, 7) >= rows[0]!.m) throw AppError.conflict('MONTH_NOT_FINISHED', 'Payroll can be run only after the month has ended', { month: monthLabel(monthDate) });
  }

  private month(text: string): string {
    const m = monthStart(text);
    if (!m) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    return m;
  }
}

export interface RunDetail extends RunSummary {
  payslips: PayslipSummary[];
  /** People who have no salary structure yet and so are not in the run. Only while it is a draft. */
  missingStructure: PersonRow[];
}

interface LineRow {
  id: string; kind: 'earning' | 'deduction'; label: string; amount: string; calculated: string; source: 'structure' | 'attendance' | 'adjustment';
  detail: string | null; reason: string | null; adjusted_by: string | null; adjusted_at: Date | null;
}
const LINE_SELECT = sql`
  SELECT l.id, l.kind, l.label, l.amount, l.calculated, l.source, l.detail, l.reason, u.name AS adjusted_by, l.adjusted_at
  FROM payslip_lines l LEFT JOIN users u ON u.id = l.adjusted_by`;

/** The policy as stored with a run: the numbers only, without the view's bookkeeping fields. */
function stripView(p: PayrollPolicy): PayrollPolicy {
  return {
    workingDaysBasis: p.workingDaysBasis, lateFreePerMonth: p.lateFreePerMonth, latePenaltyDays: p.latePenaltyDays, halfDayDeductionDays: p.halfDayDeductionDays,
    absentDeductionDays: p.absentDeductionDays, unpaidLeaveDeductionDays: p.unpaidLeaveDeductionDays, breakOverrunPerMinute: p.breakOverrunPerMinute,
  };
}

const toRunSummary = (r: RunRow): RunSummary => ({
  id: r.id, month: monthLabel(r.month), status: r.status, generatedAt: r.generated_at, generatedBy: r.generated_by, approvedAt: r.approved_at, approvedBy: r.approved_by,
  reopenedCount: r.reopened_count, policy: r.policy, people: r.people, gross: Number(r.gross), deductions: Number(r.deductions), netPay: Number(r.net),
});

const toPayslipSummary = (r: PayslipRow): PayslipSummary => ({
  id: r.id, user: { id: r.user_id, name: r.user_name, email: r.email, role: r.role }, gross: Number(r.gross), deductions: Number(r.deductions), netPay: Number(r.net_pay),
  adjusted: r.adjusted, presentDays: Number(r.present_days), absentDays: Number(r.absent_days), lateCount: r.late_count,
});

const toLineView = (l: LineRow): PayslipLineView => ({
  id: l.id, kind: l.kind, label: l.label, amount: Number(l.amount), calculated: Number(l.calculated), source: l.source, detail: l.detail, reason: l.reason,
  adjustedBy: l.adjusted_by, adjustedAt: l.adjusted_at,
});
