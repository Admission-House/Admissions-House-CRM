-- A reminder is sent once per follow-up time. reminded_at remembers that it was, and is cleared when
-- the follow-up is moved to a new time.
ALTER TABLE followups ADD COLUMN reminded_at timestamptz;

-- The reminder job looks only at follow-ups still open and not yet reminded.
CREATE INDEX followups_reminder_idx ON followups (due_at) WHERE done_at IS NULL AND reminded_at IS NULL;
