import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { scopeCondition } from '../access/scope.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppError } from '../common/app-error.js';
import type { Trx } from '../database/database.service.js';

export type UnavailableReason = 'not_checked_in' | 'checked_out' | 'on_leave' | 'on_break';

const WHY: Record<UnavailableReason, string> = {
  not_checked_in: 'has not checked in today',
  checked_out: 'has already checked out for the day',
  on_leave: 'is on approved leave today',
  on_break: 'is on a break right now',
};

/** Who a lead may be handed to. One answer for adding a lead, assigning, and importing. */
@Injectable()
export class Assignees {
  /** Someone a lead can be given to: active, able to work with leads, and inside the caller's scope. */
  async ensure(trx: Trx, auth: AuthContext, userId: string, opts: { allowUnavailable?: boolean } = {}): Promise<{ id: string; name: string }> {
    const scoped = scopeCondition(auth, 'u.id');
    const { rows } = await sql<{ id: string; name: string }>`
      SELECT u.id, u.name FROM users u
      WHERE u.id = ${userId} AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                    WHERE rp.role_id = u.role_id AND p.code = 'lead.read')
        ${scoped ? sql`AND ${scoped}` : sql``}`.execute(trx);
    if (!rows[0]) {
      throw AppError.badRequest('ASSIGNEE_INVALID', 'Choose an active person from your team who works with leads', [
        { field: 'userId', message: 'Choose an active person from your team who works with leads' },
      ]);
    }
    if (!opts.allowUnavailable) {
      const reason = await this.unavailableReason(trx, userId);
      if (reason) {
        throw new AppError('ASSIGNEE_UNAVAILABLE', `${rows[0].name} ${WHY[reason]}. Choose someone who is working now, or confirm to assign anyway.`, 409, undefined, undefined, { reason, name: rows[0].name });
      }
    }
    return rows[0];
  }

  /**
   * Why a counsellor cannot take a lead right now, or null when they can. The same test the automatic
   * hand-out uses: in today, not out, not on approved leave, not on a break. Other roles are not
   * tracked by attendance, so they are never refused.
   */
  async unavailableReason(trx: Trx, userId: string): Promise<UnavailableReason | null> {
    const { rows } = await sql<{ tracked: boolean; checked_in: boolean; open_day: boolean; on_leave: boolean; on_break: boolean }>`
      SELECT (r.system_key = 'counsellor') AS tracked,
             EXISTS (SELECT 1 FROM attendance_records a WHERE a.user_id = u.id AND a.work_date = (now() AT TIME ZONE t.timezone)::date) AS checked_in,
             EXISTS (SELECT 1 FROM attendance_records a WHERE a.user_id = u.id AND a.work_date = (now() AT TIME ZONE t.timezone)::date AND a.check_out_at IS NULL) AS open_day,
             EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.user_id = u.id AND lr.status = 'approved'
                     AND (now() AT TIME ZONE t.timezone)::date BETWEEN lr.from_date AND lr.to_date) AS on_leave,
             EXISTS (SELECT 1 FROM break_logs b JOIN attendance_records a ON a.id = b.attendance_id
                     WHERE a.user_id = u.id AND b.ended_at IS NULL) AS on_break
      FROM users u JOIN roles r ON r.id = u.role_id, tenants t
      WHERE u.id = ${userId}`.execute(trx);
    const row = rows[0];
    if (!row || !row.tracked) return null;
    if (row.on_leave) return 'on_leave';
    if (!row.checked_in) return 'not_checked_in';
    if (!row.open_day) return 'checked_out';
    if (row.on_break) return 'on_break';
    return null;
  }
}
