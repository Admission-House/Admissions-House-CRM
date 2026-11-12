-- Communication, phase A: one model for voice calls, video calls and group meetings.
--
--   video_sessions            the call or meeting itself (kept under its first name; it now holds all three)
--   video_session_invites     everybody invited: staff and outside guests, each with their own state
--   video_session_events      an append-only trail of what happened and when (invited, ringing, joined, left ...)
--
-- An outside guest gets an invitation of their own, with a link that expires, can be cancelled, and works
-- from one device only. The link is derived (HMAC) from the invitation and its version, so nothing secret is
-- stored: raising the version cancels every link sent before.

-- 1. The session ----------------------------------------------------------------------------------------
ALTER TABLE video_sessions
  ADD COLUMN type        text NOT NULL DEFAULT 'call' CHECK (type IN ('call', 'meeting')),
  ADD COLUMN title       text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 120),
  ADD COLUMN description text CHECK (description IS NULL OR char_length(description) <= 2000),
  ADD COLUMN outcome     text CHECK (outcome IN ('completed', 'missed', 'declined', 'busy', 'cancelled', 'failed')),
  ADD COLUMN failure_reason text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  ADD COLUMN reminded_at timestamptz,
  -- A meeting may be between staff only, with no lead; a call may be too.
  ALTER COLUMN lead_id DROP NOT NULL;

-- Sessions that ended before this change get an outcome that matches what happened to them.
UPDATE video_sessions SET outcome = CASE WHEN started_at IS NOT NULL THEN 'completed' ELSE 'cancelled' END WHERE status = 'ended';
ALTER TABLE video_sessions ADD CONSTRAINT video_sessions_outcome_matches_status CHECK ((status = 'ended') = (outcome IS NOT NULL));
CREATE INDEX video_sessions_history_idx ON video_sessions (tenant_id, created_at DESC, id DESC);
CREATE INDEX video_sessions_schedule_idx ON video_sessions (tenant_id, scheduled_for) WHERE status = 'open' AND scheduled_for IS NOT NULL;

-- 2. The invitations ------------------------------------------------------------------------------------
CREATE TABLE video_session_invites (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  session_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('staff', 'guest')),
  user_id         uuid,                                         -- staff
  guest_name      text CHECK (guest_name IS NULL OR length(btrim(guest_name)) BETWEEN 1 AND 80),
  role            text NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
  state           text NOT NULL DEFAULT 'invited' CHECK (state IN ('invited', 'ringing', 'accepted', 'declined', 'missed', 'busy', 'removed')),
  -- Agora's number for this person in the channel. Stable, so a second connection replaces the first.
  agora_uid       integer NOT NULL CHECK (agora_uid BETWEEN 1 AND 2147483646),
  -- Raising it cancels every link sent before for this invitation.
  token_version   integer NOT NULL DEFAULT 1,
  -- The first device a guest joined from; a link opened elsewhere is refused until the host resets it.
  device_hash     text,
  expires_at      timestamptz NOT NULL,
  invited_by      uuid NOT NULL,
  invited_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  first_joined_at timestamptz,
  joined_at       timestamptz,                                  -- set while connected
  last_left_at    timestamptz,
  last_seen_at    timestamptz,                                  -- the last sign of life from their screen
  UNIQUE (tenant_id, id),
  UNIQUE (session_id, agora_uid),
  FOREIGN KEY (tenant_id, session_id) REFERENCES video_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES users (tenant_id, id),
  CHECK ((kind = 'staff') = (user_id IS NOT NULL)),
  CHECK (kind = 'staff' OR guest_name IS NOT NULL)
);
-- One invitation per staff member per session.
CREATE UNIQUE INDEX video_session_invites_user_uq ON video_session_invites (session_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX video_session_invites_session_idx ON video_session_invites (tenant_id, session_id);
-- "What is ringing for me" and "who is in a call right now" are asked often and answer from few rows.
CREATE INDEX video_session_invites_ringing_idx ON video_session_invites (tenant_id, user_id) WHERE state = 'ringing';
CREATE INDEX video_session_invites_connected_idx ON video_session_invites (tenant_id, user_id) WHERE joined_at IS NOT NULL;
CREATE INDEX video_session_invites_invited_by_idx ON video_session_invites (tenant_id, invited_by);

SELECT apply_tenant_rls('video_session_invites');
-- Invitations are cancelled by their state, never removed.
REVOKE DELETE ON video_session_invites FROM ah_app;

-- 3. The trail ------------------------------------------------------------------------------------------
CREATE TABLE video_session_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  session_id  uuid NOT NULL,
  invite_id   uuid,
  event       text NOT NULL CHECK (event IN ('created', 'invited', 'ringing', 'accepted', 'declined', 'missed', 'busy', 'joined', 'left', 'removed', 'reset', 'started', 'ended', 'reminder')),
  detail      text CHECK (detail IS NULL OR char_length(detail) <= 300),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES video_sessions (tenant_id, id),
  FOREIGN KEY (tenant_id, invite_id) REFERENCES video_session_invites (tenant_id, id)
);
CREATE INDEX video_session_events_session_idx ON video_session_events (tenant_id, session_id, occurred_at, id);
CREATE INDEX video_session_events_invite_idx ON video_session_events (tenant_id, invite_id) WHERE invite_id IS NOT NULL;
SELECT apply_tenant_rls('video_session_events');
-- Append-only for the application role.
REVOKE UPDATE, DELETE ON video_session_events FROM ah_app;

-- 4. The people table of the first version is replaced by the invitations ---------------------------------------
DROP TABLE video_session_people;

-- 5. Permissions ----------------------------------------------------------------------------------------
-- video.host (already there) starts and joins calls and meetings. comm.manage lets an Admin end a session
-- or remove someone from a session that somebody else started, within the Admin's data scope.
INSERT INTO permissions (code, module, description) VALUES
  ('comm.manage', 'video', 'End a call or meeting that someone else started, and remove people from it');
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.system_key IN ('super_admin', 'admin') AND p.code = 'comm.manage'
ON CONFLICT DO NOTHING;

-- 6. Notifications: a type for everything about calls and meetings (incoming, missed, invited, reminder ...) ------
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('followup_due', 'assignment', 'approval', 'security', 'lead_new', 'system', 'communication'));

-- 7. Live updates: a ringing phone should not wait for a refresh ------------------------------------------
-- An invitation was made or changed: tell the person invited and the person who started the session. The
-- hint carries no data; the screen asks the API what is ringing.
CREATE FUNCTION ah_trg_call() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE starter uuid;
BEGIN
  IF NEW.user_id IS NOT NULL THEN
    PERFORM ah_emit('call', NEW.tenant_id, NEW.user_id);
  END IF;
  SELECT created_by INTO starter FROM video_sessions WHERE id = NEW.session_id;
  IF starter IS NOT NULL AND starter IS DISTINCT FROM NEW.user_id THEN
    PERFORM ah_emit('call', NEW.tenant_id, starter);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER ah_live_call AFTER INSERT OR UPDATE OF state, joined_at, token_version ON video_session_invites
  FOR EACH ROW EXECUTE FUNCTION ah_trg_call();
