import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { scopeCondition } from '../access/scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService, Trx } from '../database/database.service.js';
import type { Structure } from './payroll-calc.js';
import { monthLabel, monthStart, paise } from './payroll-rules.js';

const money = z.number().positive().max(99_999_999).multipleOf(0.01);
const line = z.object({ label: z.string().trim().min(1).max(60), amount: money });

export const structureSchema = z.object({
  userId: z.uuid(),
  /** The first month this structure applies to, as YYYY-MM. */
  effectiveFrom: z.string().trim(),
  basePay: z.number().min(0).max(99_999_999).multipleOf(0.01),
  allowances: z.array(line).max(20).default([]),
  deductions: z.array(line).max(20).default([]),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type StructureInput = z.infer<typeof structureSchema>;

export interface StructureView extends Structure {
  id: string;
  user: { id: string; name: string; email: string; role: string };
  /** YYYY-MM the structure applies from. */
  effectiveFrom: string;
  notes: string | null;
}

interface Row {
  id: string; user_id: string; user_name: string; email: string; role: string; effective_from: string; base_pay: string; notes: string | null;
}
interface LineRow { structure_id: string; kind: 'allowance' | 'deduction'; label: string; amount: string }

const SELECT = sql`
  SELECT s.id, s.user_id, u.name AS user_name, u.email::text AS email, r.name AS role, s.effective_from::text AS effective_from, s.base_pay, s.notes
  FROM salary_structures s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id`;

/**
 * What each person is paid before attendance is taken into account: base pay, allowances and fixed
 * deductions (for example HRA and PF). A structure applies from a month onwards and is kept as history.
 * Only people in the caller's reach can be read or changed, and nobody can set their own.
 */
@Injectable()
export class SalaryStructureService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** The structure in force for a month (YYYY-MM-01) for each of the given people; people without one are absent from the map. */
  async inForce(trx: Trx, userIds: readonly string[], monthDate: string): Promise<Map<string, Structure & { id: string }>> {
    const out = new Map<string, Structure & { id: string }>();
    if (userIds.length === 0) return out;
    const { rows } = await sql<{ id: string; user_id: string; base_pay: string }>`
      SELECT DISTINCT ON (user_id) id, user_id, base_pay FROM salary_structures
      WHERE user_id = ANY(${userIds as string[]}::uuid[]) AND effective_from <= ${monthDate}::date
      ORDER BY user_id, effective_from DESC`.execute(trx);
    const lines = await this.lines(trx, rows.map((r) => r.id));
    for (const r of rows) {
      const own = lines.filter((l) => l.structure_id === r.id);
      out.set(r.user_id, {
        id: r.id,
        basePay: Number(r.base_pay),
        allowances: own.filter((l) => l.kind === 'allowance').map((l) => ({ label: l.label, amount: Number(l.amount) })),
        deductions: own.filter((l) => l.kind === 'deduction').map((l) => ({ label: l.label, amount: Number(l.amount) })),
      });
    }
    return out;
  }

  /** Everyone in reach with the structure in force this month (or next month's, if it starts later), and who has none yet. */
  list(auth: AuthContext, q: { month?: string }): Promise<{ month: string; people: { user: StructureView['user']; structure: StructureView | null }[] }> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      const month = q.month ? this.month(q.month) : `${await this.companyMonth(trx, auth)}-01`;
      const scoped = scopeCondition(auth, 'u.id');
      const { rows: people } = await sql<{ id: string; name: string; email: string; role: string }>`
        SELECT u.id, u.name, u.email::text AS email, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.status = 'active' ${scoped ? sql`AND ${scoped}` : sql``} ORDER BY u.name, u.id`.execute(trx);
      const { rows } = await sql<Row>`
        ${SELECT} WHERE s.id IN (
          SELECT DISTINCT ON (user_id) id FROM salary_structures WHERE user_id = ANY(${people.map((p) => p.id)}::uuid[]) AND effective_from <= ${month}::date
          ORDER BY user_id, effective_from DESC)`.execute(trx);
      const lines = await this.lines(trx, rows.map((r) => r.id));
      const byUser = new Map(rows.map((r) => [r.user_id, toView(r, lines)]));
      return { month: monthLabel(month), people: people.map((p) => ({ user: { id: p.id, name: p.name, email: p.email, role: p.role }, structure: byUser.get(p.id) ?? null })) };
    });
  }

  /** Every version for one person, newest first. */
  history(auth: AuthContext, userId: string): Promise<StructureView[]> {
    return this.db.withTenant(auth.tenantId, async (trx) => {
      await this.reach(trx, auth, userId);
      const { rows } = await sql<Row>`${SELECT} WHERE s.user_id = ${userId}::uuid ORDER BY s.effective_from DESC LIMIT 60`.execute(trx);
      const lines = await this.lines(trx, rows.map((r) => r.id));
      return rows.map((r) => toView(r, lines));
    });
  }

  save(auth: AuthContext, input: StructureInput): Promise<StructureView> {
    const start = monthStart(input.effectiveFrom);
    if (!start) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'effectiveFrom', message: 'Give the month as YYYY-MM' }]);
    this.assertLines(input);
    return this.db.withTenant(auth.tenantId, async (trx) => {
      if (input.userId === auth.userId) throw new AppError('OWN_SALARY', 'You cannot set your own salary. Ask another admin.', 403);
      await this.reach(trx, auth, input.userId);
      const { rows: used } = await sql<{ id: string }>`SELECT id FROM payroll_runs WHERE month = ${start}::date AND status = 'approved'`.execute(trx);
      if (used[0]) throw AppError.conflict('PAYROLL_APPROVED', `The ${monthLabel(start)} payroll is approved. Start the new structure from a later month, or reopen that run first.`);

      const { rows: old } = await sql<Row>`${SELECT} WHERE s.user_id = ${input.userId}::uuid AND s.effective_from = ${start}::date FOR UPDATE OF s`.execute(trx);
      const oldLines = old[0] ? await this.lines(trx, [old[0].id]) : [];
      const notes = input.notes?.trim() || null;
      let id: string;
      if (old[0]) {
        id = old[0].id;
        await sql`UPDATE salary_structures SET base_pay = ${input.basePay}, notes = ${notes}, created_by = ${auth.userId} WHERE id = ${id}::uuid`.execute(trx);
        await sql`DELETE FROM salary_structure_lines WHERE structure_id = ${id}::uuid`.execute(trx);
      } else {
        const { rows } = await sql<{ id: string }>`
          INSERT INTO salary_structures (tenant_id, user_id, effective_from, base_pay, notes, created_by)
          VALUES (${auth.tenantId}, ${input.userId}, ${start}, ${input.basePay}, ${notes}, ${auth.userId}) RETURNING id`.execute(trx);
        id = rows[0]!.id;
      }
      let position = 0;
      for (const [kind, list] of [['allowance', input.allowances], ['deduction', input.deductions]] as const) {
        for (const l of list) {
          await sql`
            INSERT INTO salary_structure_lines (tenant_id, structure_id, kind, label, amount, position)
            VALUES (${auth.tenantId}, ${id}, ${kind}, ${l.label}, ${l.amount}, ${position++})`.execute(trx);
        }
      }
      const { rows } = await sql<Row>`${SELECT} WHERE s.id = ${id}::uuid`.execute(trx);
      const view = toView(rows[0]!, await this.lines(trx, [id]));
      await this.audit.write(trx, {
        tenantId: auth.tenantId, actorId: auth.userId, action: old[0] ? 'salary_structure.update' : 'salary_structure.create', entity: 'salary_structure', entityId: id,
        before: old[0] && toView(old[0], oldLines), after: view, ip: auth.ip, requestId: auth.requestId,
      });
      return view;
    });
  }

  // ----------------------------------------------------------------- inner

  /** Fixed deductions cannot be more than base pay plus allowances, or every payslip would start negative. */
  private assertLines(input: StructureInput): void {
    for (const [field, list] of [['allowances', input.allowances], ['deductions', input.deductions]] as const) {
      const seen = new Set<string>();
      for (const l of list) {
        const key = l.label.toLowerCase();
        if (seen.has(key)) throw AppError.badRequest('LABEL_REPEATED', `"${l.label}" is listed twice`, [{ field, message: `"${l.label}" is listed twice` }]);
        seen.add(key);
      }
    }
    const earn = paise(input.basePay) + input.allowances.reduce((s, l) => s + paise(l.amount), 0);
    const cut = input.deductions.reduce((s, l) => s + paise(l.amount), 0);
    if (cut > earn) throw new AppError('NET_NEGATIVE', 'The fixed deductions are more than base pay plus allowances', 422, [{ field: 'deductions', message: 'Lower the deductions' }]);
  }

  private async reach(trx: Trx, auth: AuthContext, userId: string): Promise<void> {
    const scoped = scopeCondition(auth, 'u.id');
    const { rows } = await sql<{ id: string }>`SELECT u.id FROM users u WHERE u.id = ${userId}::uuid ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) throw AppError.notFound('Employee');
  }

  private async lines(trx: Trx, ids: readonly string[]): Promise<LineRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<LineRow>`SELECT structure_id, kind, label, amount FROM salary_structure_lines WHERE structure_id = ANY(${ids as string[]}::uuid[]) ORDER BY position`.execute(trx);
    return rows;
  }

  private month(text: string): string {
    const m = monthStart(text);
    if (!m) throw AppError.badRequest('MONTH_INVALID', 'Give the month as YYYY-MM', [{ field: 'month', message: 'Give the month as YYYY-MM' }]);
    return m;
  }

  private async companyMonth(trx: Trx, auth: AuthContext): Promise<string> {
    const { rows } = await sql<{ m: string }>`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM') AS m FROM tenants WHERE id = ${auth.tenantId}`.execute(trx);
    return rows[0]!.m;
  }
}

function toView(r: Row, lines: readonly LineRow[]): StructureView {
  const own = lines.filter((l) => l.structure_id === r.id);
  return {
    id: r.id,
    user: { id: r.user_id, name: r.user_name, email: r.email, role: r.role },
    effectiveFrom: monthLabel(r.effective_from),
    basePay: Number(r.base_pay),
    allowances: own.filter((l) => l.kind === 'allowance').map((l) => ({ label: l.label, amount: Number(l.amount) })),
    deductions: own.filter((l) => l.kind === 'deduction').map((l) => ({ label: l.label, amount: Number(l.amount) })),
    notes: r.notes,
  };
}
