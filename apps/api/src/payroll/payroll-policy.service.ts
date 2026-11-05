import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { PayrollPolicy } from './payroll-calc.js';
import { monthLabel, monthStart } from './payroll-rules.js';

/**
 * The values used until the company sets its own. They are the proposal made to the client in the SRS
 * (section 7.2) and are meant to be confirmed with them; none of them is fixed in the calculation.
 */
export const DEFAULT_POLICY: PayrollPolicy = {
  workingDaysBasis: 'working',
  lateFreePerMonth: 3,
  latePenaltyDays: 0.25,
  halfDayDeductionDays: 0.5,
  absentDeductionDays: 1,
  unpaidLeaveDeductionDays: 1,
  breakOverrunPerMinute: 0,
};

const days = (max: number) => z.number().min(0).max(max).multipleOf(0.25);

export const policySchema = z.object({
  /** The first month the rules apply to, as YYYY-MM. */
  effectiveFrom: z.string().trim(),
  workingDaysBasis: z.enum(['calendar', 'working']),
  lateFreePerMonth: z.number().int().min(0).max(31),
  latePenaltyDays: days(5),
  halfDayDeductionDays: days(1),
  absentDeductionDays: days(5),
  unpaidLeaveDeductionDays: days(5),
  breakOverrunPerMinute: z.number().min(0).max(100_000).multipleOf(0.01),
});
export type PolicyInput = z.infer<typeof policySchema>;

export interface PolicyView extends PayrollPolicy {
  /** YYYY-MM, or null for the built-in proposal that no one has saved yet. */
  effectiveFrom: string | null;
  isDefault: boolean;
}

interface Row {
  effective_from: string;
  working_days_basis: PayrollPolicy['workingDaysBasis'];
  late_free_per_month: number;
  late_penalty_days: string;
  half_day_deduction_days: string;
  absent_deduction_days: string;
  unpaid_leave_deduction_days: string;
  break_overrun_per_minute: string;
}

const toPolicy = (r: Row): PayrollPolicy => ({
  workingDaysBasis: r.working_days_basis,
  lateFreePerMonth: r.late_free_per_month,
  latePenaltyDays: Number(r.late_penalty_days),
  halfDayDeductionDays: Number(r.half_day_deduction_days),
  absentDeductionDays: Number(r.absent_deduction_days),
  unpaidLeaveDeductionDays: Number(r.unpaid_leave_deduction_days),
  breakOverrunPerMinute: Number(r.break_overrun_per_minute),
});

const COLUMNS = sql`effective_from::text AS effective_from, working_days_basis, late_free_per_month, late_penalty_days, half_day_deduction_days,
  absent_deduction_days, unpaid_leave_deduction_days, break_overrun_per_minute`;

/**
 * The payroll policy: the rules that turn attendance into deductions. Each save is a new version that
 * applies from a month onwards, so a past month keeps the rules it was calculated under (the run also
 * keeps a copy). Nothing here is fixed in code: the Super Admin changes every value in Settings.
 */
@Injectable()
export class PayrollPolicyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** The rules in force for a month (YYYY-MM-01): the latest version that starts on or before it. */
  async effective(trx: Trx, monthDate: string): Promise<PolicyView> {
    const { rows } = await sql<Row>`SELECT ${COLUMNS} FROM payroll_policies WHERE effective_from <= ${monthDate}::date ORDER BY effective_from DESC LIMIT 1`.execute(trx);
    return rows[0] ? { ...toPolicy(rows[0]), effectiveFrom: monthLabel(rows[0].effective_from), isDefault: false } : { ...DEFAULT_POLICY, effectiveFrom: null, isDefault: true };
  }

  current(auth: AuthContext): Promise<{ current: PolicyView; history: PolicyView[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const month = await this.companyMonth(trx, auth);
      const { rows } = await sql<Row>`SELECT ${COLUMNS} FROM payroll_policies ORDER BY effective_from DESC LIMIT 24`.execute(trx);
      return {
        current: await this.effective(trx, `${month}-01`),
        history: rows.map((r) => ({ ...toPolicy(r), effectiveFrom: monthLabel(r.effective_from), isDefault: false })),
      };
    });
  }

  /**
   * Saves a version from a month onwards. A month that is already approved cannot be affected, because
   * its payslips are final: the rules must start after the last approved month.
   */
  save(auth: AuthContext, input: PolicyInput): Promise<PolicyView> {
    const start = monthStart(input.effectiveFrom);
    if (!start) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'effectiveFrom', message: 'Give the month as YYYY-MM' }]);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const { rows: approved } = await sql<{ month: string }>`SELECT month::text AS month FROM payroll_runs WHERE status = 'approved' AND month >= ${start}::date ORDER BY month DESC LIMIT 1`.execute(trx);
      if (approved[0]) {
        throw AppError.conflict('POLICY_AFFECTS_APPROVED_RUN', `The ${monthLabel(approved[0].month)} payroll is already approved, so rules cannot start before ${nextMonth(approved[0].month)}`, { approvedMonth: monthLabel(approved[0].month) });
      }
      const before = await this.effective(trx, start);
      await sql`
        INSERT INTO payroll_policies (tenant_id, effective_from, working_days_basis, late_free_per_month, late_penalty_days, half_day_deduction_days,
                                      absent_deduction_days, unpaid_leave_deduction_days, break_overrun_per_minute, created_by)
        VALUES (${auth.tenantId}, ${start}, ${input.workingDaysBasis}, ${input.lateFreePerMonth}, ${input.latePenaltyDays}, ${input.halfDayDeductionDays},
                ${input.absentDeductionDays}, ${input.unpaidLeaveDeductionDays}, ${input.breakOverrunPerMinute}, ${auth.userId})
        ON CONFLICT (tenant_id, effective_from) DO UPDATE SET
          working_days_basis = EXCLUDED.working_days_basis, late_free_per_month = EXCLUDED.late_free_per_month, late_penalty_days = EXCLUDED.late_penalty_days,
          half_day_deduction_days = EXCLUDED.half_day_deduction_days, absent_deduction_days = EXCLUDED.absent_deduction_days,
          unpaid_leave_deduction_days = EXCLUDED.unpaid_leave_deduction_days, break_overrun_per_minute = EXCLUDED.break_overrun_per_minute,
          created_by = EXCLUDED.created_by`.execute(trx);
      const after = await this.effective(trx, start);
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: 'payroll.policy_change', entity: 'payroll_policy', entityId: null,
        before: before.isDefault ? null : before, after, ip: auth.ip, requestId: auth.requestId,
      });
      return after;
    });
  }

  private async companyMonth(trx: Trx, auth: AuthContext): Promise<string> {
    const { rows } = await sql<{ m: string }>`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM') AS m FROM tenants WHERE id = ${auth.tenantId}`.execute(trx);
    return rows[0]!.m;
  }
}

/** The month after YYYY-MM-DD, as YYYY-MM. */
function nextMonth(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
}
