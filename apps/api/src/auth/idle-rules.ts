import { sql } from 'kysely';

/** How long past a break's allowance a person who stepped away on a break is still given before they count as idle. */
export const BREAK_GRACE_MINUTES = 10;

/**
 * How many minutes of quiet are fine for the session `s` because its person is on a break: the length of that break
 * plus a little grace, so a 45 minute lunch does not end in a sign-out after 30 minutes of idle time. The usual limit
 * still applies if it is longer. Zero when they are not on a break. Written to be placed inside a query that has the
 * session table as `s`.
 */
export const onBreakQuietMinutes = sql<number>`COALESCE((
  SELECT bt.allowed_minutes + ${BREAK_GRACE_MINUTES}
  FROM break_logs b
  JOIN break_types bt ON bt.id = b.break_type_id
  JOIN attendance_records ar ON ar.id = b.attendance_id
  WHERE ar.user_id = s.user_id AND b.ended_at IS NULL
  LIMIT 1), 0)`;
