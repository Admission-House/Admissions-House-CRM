-- A leave type can be switched off without deleting it (requests refer to it), and a decision
-- can carry a note, such as the reason a request was turned down.

ALTER TABLE leave_types    ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE leave_requests ADD COLUMN decision_note text;

-- "My requests" lists, newest first.
CREATE INDEX leave_requests_user_idx ON leave_requests (tenant_id, user_id, from_date DESC);
