-- Attendance follows the session. When the last live session of a person ends, for whatever
-- reason (sign out, 30 minutes idle, expiry, an Admin ending it), their day is checked out and
-- any break still open is closed. Doing it here means no code path can forget.

CREATE FUNCTION close_attendance_on_session_end() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM user_sessions s
       WHERE s.user_id = NEW.user_id AND s.id <> NEW.id AND s.ended_at IS NULL
     )
  THEN
    -- Close a break that is still running, at the moment the person was checked out.
    UPDATE break_logs b SET ended_at = GREATEST(NEW.ended_at, b.started_at)
    FROM attendance_records a
    WHERE b.attendance_id = a.id AND a.user_id = NEW.user_id
      AND a.check_out_at IS NULL AND b.ended_at IS NULL;

    UPDATE attendance_records a
    SET check_out_at = GREATEST(NEW.ended_at, a.check_in_at),
        check_out_reason = CASE NEW.ended_reason
                             WHEN 'logout'     THEN 'manual'
                             WHEN 'inactivity' THEN 'inactivity'
                             ELSE 'forced'
                           END
    WHERE a.user_id = NEW.user_id AND a.check_out_at IS NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_close_attendance_on_session_end
AFTER UPDATE OF ended_at ON user_sessions
FOR EACH ROW EXECUTE FUNCTION close_attendance_on_session_end();

-- The background sweep has to visit every company, but row-level security hides other companies
-- from it. This returns only their ids.
CREATE FUNCTION list_active_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id FROM tenants WHERE status = 'active' $$;

REVOKE ALL ON FUNCTION list_active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_active_tenant_ids() TO ah_app;

-- Listing attendance by day and person.
CREATE INDEX attendance_user_date_idx ON attendance_records (tenant_id, user_id, work_date DESC);
