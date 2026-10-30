import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';

export interface MonthSummary {
  userId: string;
  /** Days in the month that are neither a weekly off nor a holiday, up to today for the current month. */
  workingDays: number;
  present: number;
  late: number;
  lateMinutes: number;
  /** Working days covered by approved leave. */
  leaveDays: number;
  absent: number;
}

/**
 * The attendance of a month in numbers: present, late, on leave, absent. It is shown beside a salary
 * for reference and feeds the attendance reports; it never changes an amount. The weekly offs in
 * force on each day come from the versioned attendance settings, so a past month keeps the rules it
 * was lived under.
 */
@Injectable()
export class AttendanceSummaryService {
  /** `month` is the first day of the month, as YYYY-MM-01. */
  async forMonth(trx: Trx, userIds: readonly string[], month: string): Promise<Map<string, MonthSummary>> {
    const out = new Map<string, MonthSummary>();
    if (userIds.length === 0) return out;
    const { rows } = await sql<{ user_id: string; working: number; present: number; late: number; late_min: number; leave_days: number }>`
      WITH tz AS (SELECT timezone FROM tenants LIMIT 1),
      days AS (
        SELECT d::date AS day FROM generate_series(${month}::date, (${month}::date + interval '1 month - 1 day')::date, interval '1 day') d
        WHERE d::date <= (now() AT TIME ZONE (SELECT timezone FROM tz))::date
      ),
      working AS (
        SELECT d.day FROM days d
        LEFT JOIN LATERAL (SELECT weekly_off_days FROM attendance_settings WHERE effective_from <= d.day ORDER BY effective_from DESC LIMIT 1) s ON true
        WHERE NOT (extract(dow FROM d.day)::smallint = ANY (coalesce(s.weekly_off_days, '{0}'::smallint[])))
          AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = d.day)
      )
      SELECT u.id AS user_id,
             (SELECT count(*) FROM working)::int AS working,
             (SELECT count(*) FROM attendance_records a WHERE a.user_id = u.id AND a.work_date IN (SELECT day FROM days))::int AS present,
             (SELECT count(*) FROM attendance_records a WHERE a.user_id = u.id AND a.work_date IN (SELECT day FROM days) AND a.late_minutes > 0)::int AS late,
             (SELECT coalesce(sum(a.late_minutes), 0) FROM attendance_records a WHERE a.user_id = u.id AND a.work_date IN (SELECT day FROM days))::int AS late_min,
             (SELECT count(*) FROM leave_requests r, working w
               WHERE r.user_id = u.id AND r.status = 'approved' AND w.day BETWEEN r.from_date AND r.to_date
                 AND NOT EXISTS (SELECT 1 FROM attendance_records a WHERE a.user_id = u.id AND a.work_date = w.day))::int AS leave_days
      FROM users u WHERE u.id = ANY(${userIds as string[]}::uuid[])`.execute(trx);
    for (const r of rows) {
      out.set(r.user_id, {
        userId: r.user_id, workingDays: r.working, present: r.present, late: r.late, lateMinutes: r.late_min, leaveDays: r.leave_days,
        absent: Math.max(0, r.working - r.present - r.leave_days),
      });
    }
    return out;
  }
}
