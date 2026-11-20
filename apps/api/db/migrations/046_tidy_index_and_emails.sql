-- Two small clean-ups found in the audit.
-- 1. call_recordings_call_idx and call_recordings_one_per_call index the same column; the unique one already serves every lookup,
--    so the second copy only slows writes and wastes space.
DROP INDEX IF EXISTS call_recordings_call_idx;

-- 2. Sign-in emails are compared without regard to case (the column is case-insensitive), but two were stored with capitals.
--    Store them all the same way, as new ones already are.
UPDATE users SET email = lower(email::text) WHERE email::text <> lower(email::text);
