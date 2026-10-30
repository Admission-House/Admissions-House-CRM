import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { Trx } from '../database/database.service.js';

export interface SettingsRow {
  id: string;
  effective_from: string;
  shift_start: string;
  shift_end: string;
  grace_minutes: number;
  half_day_below_hours: string;
  idle_timeout_min: number;
  weekly_off_days: number[];
}

/**
 * The SQL of attendance. The working day is the company's own: "today" and the shift are read in the
 * company's time zone, never the server's, so a server in another zone gives the same answers.
 */
@Injectable()
export class AttendanceRepository {
  /** Today's date in the company's time zone, as YYYY-MM-DD. */
  async localToday(trx: Trx): Promise<string> {
    const { rows } = await sql<{ d: string }>`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM tenants`.execute(trx);
    return rows[0]!.d;
  }

  /** The settings in force today. Null if the company has none yet. */
  async currentSettings(trx: Trx): Promise<SettingsRow | undefined> {
    const { rows } = await sql<SettingsRow>`
      SELECT a.id, a.effective_from::text AS effective_from, a.shift_start::text AS shift_start,
             a.shift_end::text AS shift_end, a.grace_minutes, a.half_day_below_hours::text AS half_day_below_hours,
             a.idle_timeout_min, a.weekly_off_days::int[] AS weekly_off_days
      FROM attendance_settings a, tenants t
      WHERE a.effective_from <= (now() AT TIME ZONE t.timezone)::date
      ORDER BY a.effective_from DESC LIMIT 1`.execute(trx);
    return rows[0];
  }

  /**
   * Records that a person is in the office. There is one record a day: the first sign-in is the
   * check-in, and signing in again the same day (after a break away, or an idle sign-out) reopens
   * the day without counting it twice or changing the late minutes.
   *
   * A person is late when they arrive after the shift start plus the grace period; the minutes are
   * counted from the shift start. Times are compared as dates and times together, so a shift near
   * midnight cannot wrap around.
   */
  async checkIn(
    trx: Trx,
    p: {
      tenantId: string;
      userId: string;
      branchId: string | null;
      ip: string;
      lat?: number;
      lng?: number;
      accuracy?: number;
    },
  ): Promise<void> {
    await sql`
      WITH l AS (SELECT (now() AT TIME ZONE timezone) AS ts FROM tenants),
           s AS (
             SELECT a.shift_start, a.grace_minutes FROM attendance_settings a, l
             WHERE a.effective_from <= l.ts::date ORDER BY a.effective_from DESC LIMIT 1
           )
      INSERT INTO attendance_records
        (tenant_id, user_id, work_date, branch_id, check_in_at, check_in_lat, check_in_lng,
         check_in_accuracy_m, check_in_ip, method, late_minutes)
      SELECT ${p.tenantId}, ${p.userId}, l.ts::date, ${p.branchId}, now(), ${p.lat ?? null}, ${p.lng ?? null},
             ${p.accuracy ?? null}, ${p.ip}::inet, 'office_check',
             COALESCE(CASE WHEN l.ts > (l.ts::date + s.shift_start) + make_interval(mins => s.grace_minutes)
                           THEN floor(EXTRACT(EPOCH FROM l.ts - (l.ts::date + s.shift_start)) / 60)::int END, 0)
      FROM l LEFT JOIN s ON true
      ON CONFLICT (user_id, work_date) DO UPDATE
        SET check_out_at = NULL, check_out_reason = NULL`.execute(trx);
  }
}
