import { sql } from 'kysely';

/**
 * Whether the idle sign-out applies to the person of session `s`: only to those whose attendance is kept (the office staff).
 * A Super Admin, who works from anywhere and keeps no attendance, is not signed out for being quiet. Written to be placed
 * inside a query that has the session table as `s`.
 */
export const idleSignOutApplies = sql<boolean>`COALESCE((
  SELECT r.tracks_attendance FROM users iu JOIN roles r ON r.id = iu.role_id AND r.tenant_id = iu.tenant_id WHERE iu.id = s.user_id), true)`;

/** The idle limit, in minutes, for someone the idle sign-out does not apply to: more than any session lasts. */
export const NO_IDLE_LIMIT_MIN = 525_600;

/** A little past the day's break limit, so the sweep that ends a break at the limit acts before the idle sign-out does. */
export const BREAK_GRACE_MINUTES = 5;

/**
 * How many minutes of quiet are fine for the session `s` because its person is on a break: up to the day's limit on break
 * time (after which they are signed out anyway) plus a little. The usual limit still applies if it is longer. Zero when
 * they are not on a break. Written to be placed inside a query that has the session table as `s`.
 */
export const onBreakQuietMinutes = sql<number>`(
  SELECT COALESCE((SELECT a.break_hard_limit_minutes FROM attendance_settings a
                   WHERE a.effective_from <= (now() AT TIME ZONE (SELECT t.timezone FROM tenants t LIMIT 1))::date
                   ORDER BY a.effective_from DESC LIMIT 1), 100) + ${BREAK_GRACE_MINUTES}
  WHERE EXISTS (SELECT 1 FROM break_logs b JOIN attendance_records ar ON ar.id = b.attendance_id
                WHERE ar.user_id = s.user_id AND b.ended_at IS NULL))`;
