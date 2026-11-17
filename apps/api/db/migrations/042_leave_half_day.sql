-- A half day of leave is the first half or the second half of the working day. Which half matters: the person is at
-- work for the other half, so they can still be given leads then, and the leave screens can say which half it is.
ALTER TABLE leave_requests ADD COLUMN half text CHECK (half IN ('first', 'second'));
-- Half days taken before this was recorded: the half is not known, so they are shown as the first half.
UPDATE leave_requests SET half = 'first' WHERE days = 0.5 AND from_date = to_date;
ALTER TABLE leave_requests ADD CONSTRAINT leave_half_is_one_half_day CHECK (half IS NULL OR (from_date = to_date AND days = 0.5));
