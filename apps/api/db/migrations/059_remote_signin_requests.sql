-- Signing in from outside the office, with approval.
--
-- Office staff sign in only from the office. When one of them is somewhere else (a college visit, working from home for a day), they
-- can ask for approval instead of being turned away: after the password (and two-step code) is right, a request goes to the Super
-- Admins and their team Admin with the reason and where they are. Once someone approves it, the person may sign in from outside the
-- office for the rest of that day (the company's calendar day), and signing in marks them present as usual; the record says it was
-- approved. A request not answered within a few minutes expires. The waiting browser holds a random token to ask how it went; only
-- its hash is stored.
CREATE TABLE remote_signin_requests (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
  reason        text NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 300),
  -- Why the office check said no (gps_far, network, gps_missing...), and where the person was, when the browser could tell.
  office_reason text,
  ip            inet,
  lat           numeric(9, 6),
  lng           numeric(9, 6),
  accuracy_m    integer,
  distance_m    integer,
  poll_hash     text NOT NULL,
  expires_at    timestamptz NOT NULL,
  -- The company's calendar day the approval is for.
  work_date     date NOT NULL,
  decided_by    uuid,
  decided_at    timestamptz,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  CHECK ((state IN ('approved', 'rejected')) = (decided_by IS NOT NULL))
);
CREATE INDEX remote_signin_requests_user_idx ON remote_signin_requests (tenant_id, user_id, work_date, state);
CREATE INDEX remote_signin_requests_state_idx ON remote_signin_requests (tenant_id, state, created_at DESC);
SELECT apply_tenant_rls('remote_signin_requests');
GRANT SELECT, INSERT, UPDATE ON remote_signin_requests TO ah_app;

-- An attendance day can now also start with an approved sign-in from outside the office.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'attendance_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%office_check%' LOOP
    EXECUTE format('ALTER TABLE attendance_records DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_method_check CHECK (method IN ('office_check', 'exception', 'remote_approved'));
