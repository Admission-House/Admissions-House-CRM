-- Registered office computers.
--
-- An office sign-in used to need two things: an internet address on the office's list, and the person's position at the office. The
-- address changes whenever the internet provider decides, so people were turned away at the door almost every day, and keeping the
-- list right was never finished. A computer that has already proved it belongs to the office does not need to prove it again each
-- morning: from then on the person's position is the proof of being at the office, whatever address the provider gave that day.
--
-- A browser keeps a random token in a protected cookie. Only a hash of it is stored here. A computer becomes registered in one of two
-- ways: the person signs in from an address on the office list (that is the old proof, so the computer is registered at once), or the
-- person signs in from somewhere else but at the office, and a Super Admin or Admin approves the request. An unregistered computer
-- that is not at the office is never even asked about.
CREATE TABLE office_computers (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  token_hash   text NOT NULL,
  state        text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'removed')),
  -- How it got registered: from an address on the office list, or approved by a person.
  registered_by text CHECK (registered_by IN ('office_network', 'approval')),
  label        text,
  first_ip     inet,
  last_ip      inet,
  decided_by   uuid,
  decided_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- A computer shared by two people is registered for each of them on its own.
  UNIQUE (user_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  CHECK ((state = 'approved') = (registered_by IS NOT NULL))
);
CREATE INDEX office_computers_state_user_idx ON office_computers (tenant_id, user_id, state);
CREATE INDEX office_computers_state_idx ON office_computers (tenant_id, state, created_at DESC);
SELECT apply_tenant_rls('office_computers');
GRANT SELECT, INSERT, UPDATE ON office_computers TO ah_app;
CREATE TRIGGER ah_live_admin AFTER INSERT OR UPDATE OR DELETE ON office_computers
  FOR EACH ROW EXECUTE FUNCTION ah_trg_topic('admin');
