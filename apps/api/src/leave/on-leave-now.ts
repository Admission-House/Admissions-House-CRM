import { sql } from 'kysely';

/**
 * True when the person `u` is on approved leave right now. A whole-day leave covers the day. A half day covers only
 * its half of the working day (before or after the middle of the shift), so the person can be given leads in the
 * other half. Written to be placed inside a query that has the person as `u` and the company as `t`.
 */
export const onLeaveNow = sql<boolean>`EXISTS (
  SELECT 1 FROM leave_requests lr
  WHERE lr.user_id = u.id AND lr.status = 'approved'
    AND (now() AT TIME ZONE t.timezone)::date BETWEEN lr.from_date AND lr.to_date
    AND (lr.half IS NULL OR lr.half = CASE
      WHEN (now() AT TIME ZONE t.timezone)::time < COALESCE(
        (SELECT s.shift_start + (s.shift_end - s.shift_start) / 2 FROM attendance_settings s
         WHERE s.effective_from <= (now() AT TIME ZONE t.timezone)::date ORDER BY s.effective_from DESC LIMIT 1), TIME '14:00')
      THEN 'first' ELSE 'second' END))`;
