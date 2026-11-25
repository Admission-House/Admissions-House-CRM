-- Worked time counts only the time a person was signed in.
--
-- A day runs from the first sign-in to the last sign-out. A person signed out in between (idle for too long, or signed out by
-- hand) and back later was counted as working all that time, so the "fewer hours than a half day" rule could not catch them.
-- The minutes away are now added up on the day's record each time it is reopened by a new sign-in, and worked time is
-- (check-out - check-in) - minutes away - breaks. They are kept on the record because sign-in sessions are deleted after a
-- while, and a month's payroll must give the same answer when it is run again later.
ALTER TABLE attendance_records ADD COLUMN away_minutes integer NOT NULL DEFAULT 0 CHECK (away_minutes >= 0);

-- Days already recorded: the time between the first sign-in and the last sign-out that no session covered. A day marked by
-- an Admin (no sessions) and a day whose sessions are already gone are left as they were.
WITH spans AS (
  SELECT a.id, floor(extract(epoch FROM a.check_out_at - a.check_in_at) / 60)::int AS span,
         (SELECT floor(extract(epoch FROM sum(upper(r) - lower(r))) / 60)::int
            FROM unnest((
              SELECT range_agg(tstzrange(lo, hi))
              FROM (SELECT greatest(s.created_at, a.check_in_at) AS lo,
                           least(coalesce(s.ended_at, least(s.expires_at, now())), a.check_out_at) AS hi
                    FROM user_sessions s
                    WHERE s.user_id = a.user_id AND s.created_at < a.check_out_at
                      AND coalesce(s.ended_at, s.expires_at) > a.check_in_at) x
              WHERE lo < hi)) r) AS signed_in
  FROM attendance_records a
  WHERE a.method <> 'exception' AND a.check_out_at IS NOT NULL
)
UPDATE attendance_records a SET away_minutes = greatest(0, s.span - s.signed_in)
FROM spans s WHERE s.id = a.id AND s.signed_in > 0 AND s.span > s.signed_in;
