-- When a recording download was last tried, so a failing one is retried with growing gaps.
ALTER TABLE call_recordings ADD COLUMN last_attempt_at timestamptz;
