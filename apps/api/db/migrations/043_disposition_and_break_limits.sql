-- 1. Disposing a lead: a status can need a sub-status (a reason), and a sub-status can need a comment ("Other
--    reasons (comments required)"). Both are settings, so a company decides which.
ALTER TABLE lead_statuses ADD COLUMN requires_substatus boolean NOT NULL DEFAULT false;
ALTER TABLE lead_substatuses ADD COLUMN requires_comment boolean NOT NULL DEFAULT false;

-- 2. Breaks: a hard limit on the minutes of break in a day, after which the person is signed out. The allowance of each
--    kind of break is when the supervisors are told; this is when it stops. And a mark that they were told today.
ALTER TABLE attendance_settings ADD COLUMN break_hard_limit_minutes smallint NOT NULL DEFAULT 100 CHECK (break_hard_limit_minutes BETWEEN 10 AND 480);
ALTER TABLE attendance_records ADD COLUMN break_warned_at timestamptz;
