import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';
import type { DayFacts } from './payroll-calc.js';
import { monthDays } from './payroll-calc.js';

export interface MonthFacts {
  calendarDays: number;
  /** Per person: one entry for every date of the month. */
  days: Map<string, DayFacts[]>;
}

/**
 * Reads what happened in a month for a group of people: which days were working days, who was in,
 * for how long, who was late, who was on approved leave and how long breaks ran over. It only reads;
 * the rules that turn this into money are in payroll-calc.ts.
 *
 * "Working day" follows the attendance settings in force on that date (weekly offs) and the company
 * holidays, the same as the attendance reports, so a payslip and the attendance screens agree.
 */
@Injectable()
export class PayrollFactsService {
  /** `monthDate` is the first day of the month, as YYYY-MM-01. */
  async forMonth(trx: Trx, userIds: readonly string[], monthDate: string): Promise<MonthFacts> {
    const dates = monthDays(monthDate);
    const first = dates[0]!.date;
    const last = dates[dates.length - 1]!.date;
    const ids = userIds as string[];

    // One connection runs one query at a time, so the four reads are simply made one after the other.
    const calendar = await sql<{ day: string; is_working: boolean; half_minutes: number }>`
        SELECT g::date::text AS day,
               NOT (extract(dow FROM g)::smallint = ANY (coalesce(s.weekly_off_days, '{0}'::smallint[])))
                 AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = g::date) AS is_working,
               round(coalesce(s.half_day_below_hours, 4.5) * 60)::int AS half_minutes
        FROM generate_series(${first}::date, ${last}::date, interval '1 day') g
        LEFT JOIN LATERAL (SELECT weekly_off_days, half_day_below_hours FROM attendance_settings WHERE effective_from <= g::date ORDER BY effective_from DESC LIMIT 1) s ON true
        ORDER BY 1`.execute(trx);

    // Minutes are whole minutes. A break that is still open cannot be measured, and the check-out closes every break.
    const attendance = await sql<{ user_id: string; day: string; late_minutes: number; worked_minutes: number | null; over_minutes: number }>`
        SELECT a.user_id, a.work_date::text AS day, a.late_minutes,
               CASE WHEN a.check_out_at IS NULL THEN NULL
                    ELSE greatest(0, floor(extract(epoch FROM a.check_out_at - a.check_in_at) / 60) - coalesce(b.taken, 0))::int END AS worked_minutes,
               coalesce(b.over, 0)::int AS over_minutes
        FROM attendance_records a
        LEFT JOIN LATERAL (
          SELECT sum(floor(extract(epoch FROM l.ended_at - l.started_at) / 60)) AS taken,
                 sum(greatest(0, floor(extract(epoch FROM l.ended_at - l.started_at) / 60) - t.allowed_minutes)) AS over
          FROM break_logs l JOIN break_types t ON t.id = l.break_type_id
          WHERE l.attendance_id = a.id AND l.ended_at IS NOT NULL) b ON true
        WHERE a.user_id = ANY(${ids}::uuid[]) AND a.work_date BETWEEN ${first}::date AND ${last}::date`.execute(trx);

    // A request's days are spread over its working dates (a half day is one date at 0.5), then cut to this month.
    const leave = await sql<{ user_id: string; day: string; share: number; is_paid: boolean }>`
        WITH req AS (
          SELECT r.id, r.user_id, r.from_date, r.to_date, r.days, t.is_paid
          FROM leave_requests r JOIN leave_types t ON t.id = r.leave_type_id
          WHERE r.status = 'approved' AND r.user_id = ANY(${ids}::uuid[]) AND r.from_date <= ${last}::date AND r.to_date >= ${first}::date),
        cal AS (
          SELECT g::date AS day,
                 NOT (extract(dow FROM g)::smallint = ANY (coalesce((SELECT weekly_off_days FROM attendance_settings WHERE effective_from <= g::date ORDER BY effective_from DESC LIMIT 1), '{0}'::smallint[])))
                   AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = g::date) AS is_working
          FROM generate_series((SELECT min(from_date) FROM req), (SELECT max(to_date) FROM req), interval '1 day') g),
        eligible AS (
          SELECT r.id, count(*)::int AS n FROM req r JOIN cal c ON c.day BETWEEN r.from_date AND r.to_date AND c.is_working GROUP BY r.id)
        SELECT r.user_id, c.day::text AS day, least(1, r.days / e.n)::float8 AS share, r.is_paid
        FROM req r JOIN eligible e ON e.id = r.id
        JOIN cal c ON c.day BETWEEN r.from_date AND r.to_date AND c.is_working AND c.day BETWEEN ${first}::date AND ${last}::date`.execute(trx);

    const joined = await sql<{ id: string; joined_on: string | null }>`SELECT id, joined_on::text AS joined_on FROM users WHERE id = ANY(${ids}::uuid[])`.execute(trx);

    const attendanceBy = new Map(attendance.rows.map((a) => [`${a.user_id}|${a.day}`, a]));
    const leaveBy = new Map(leave.rows.map((l) => [`${l.user_id}|${l.day}`, l]));
    const joinedOn = new Map(joined.rows.map((u) => [u.id, u.joined_on]));

    const days = new Map<string, DayFacts[]>();
    for (const userId of userIds) {
      const joinedDay = joinedOn.get(userId) ?? null;
      days.set(
        userId,
        calendar.rows.map((c): DayFacts => {
          const a = attendanceBy.get(`${userId}|${c.day}`);
          const l = leaveBy.get(`${userId}|${c.day}`);
          return {
            date: c.day,
            isWorking: c.is_working,
            ...(joinedDay && c.day < joinedDay && { beforeJoining: true }),
            ...(a && { attendance: { lateMinutes: a.late_minutes, workedMinutes: a.worked_minutes, halfDayBelowMinutes: c.half_minutes, breakOverMinutes: a.over_minutes } }),
            ...(l && { leave: { share: l.share, paid: l.is_paid } }),
          };
        }),
      );
    }
    return { calendarDays: dates.length, days };
  }
}
