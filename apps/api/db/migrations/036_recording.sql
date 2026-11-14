-- Recording of calls and meetings (Agora Cloud Recording), phase B.
--
--   recording_policies           what the company decided: off, optional (the host chooses) or always; the
--                                notice every person sees before joining; how long recordings are kept
--   session_recordings           one recording of one session, with the state of the Agora task and of the file
--   session_recording_files      the files that were found in the storage bucket and checked
--   recording_webhook_events     every notice Agora sent, once (notices can arrive twice)
--
-- A session is recorded only if the policy said so when the session was made, and only people who
-- agreed to the notice are let in (consent is kept per person with the notice version they saw).

-- 1. Policy ----------------------------------------------------------------------------------------------
CREATE TABLE recording_policies (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants (id),
  mode           text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'optional', 'always')),
  retention_days integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  notice_text    text NOT NULL CHECK (length(btrim(notice_text)) BETWEEN 10 AND 1000),
  -- Raised whenever the notice or the mode changes, so each session and each consent says which one applied.
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);
SELECT apply_tenant_rls('recording_policies');
SELECT apply_updated_at('recording_policies');
REVOKE DELETE ON recording_policies FROM ah_app;

-- 2. What a session and a person agreed to --------------------------------------------------------------
ALTER TABLE video_sessions
  ADD COLUMN recording_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN recording_policy_version integer;
ALTER TABLE video_session_invites
  ADD COLUMN consented_at timestamptz,
  ADD COLUMN consent_notice_version integer;
ALTER TABLE video_session_events DROP CONSTRAINT video_session_events_event_check;
ALTER TABLE video_session_events ADD CONSTRAINT video_session_events_event_check
  CHECK (event IN ('created', 'invited', 'ringing', 'accepted', 'declined', 'missed', 'busy', 'joined', 'left', 'removed', 'reset', 'started', 'ended', 'reminder',
                   'consent', 'recording'));

-- 3. Recordings -------------------------------------------------------------------------------------------
CREATE TABLE session_recordings (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  session_id       uuid NOT NULL,
  provider         text NOT NULL DEFAULT 'agora_cloud' CHECK (provider IN ('agora_cloud')),
  -- pending: wanted, not yet asked of Agora. starting: Agora is being asked. recording: Agora confirmed.
  -- stopping: told to stop. processing: stopped, waiting for the file to be found and checked.
  -- available: a playable file was found and checked. failed: see failure_reason. expired: removed after retention.
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'starting', 'recording', 'stopping', 'processing', 'available', 'failed', 'expired')),
  failure_reason   text CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  -- The number the recorder uses in the channel (it is a member of the channel like anyone else).
  bot_uid          integer NOT NULL CHECK (bot_uid BETWEEN 1 AND 2147483646),
  stream_types     smallint NOT NULL CHECK (stream_types IN (0, 2)),   -- 0 sound only, 2 sound and picture
  resource_id      text,
  sid              text,
  -- Where Agora writes the files in the bucket: letters and digits only, one folder per company and per session.
  file_prefix      text NOT NULL CHECK (file_prefix ~ '^[A-Za-z0-9]+(/[A-Za-z0-9]+)*$' AND char_length(file_prefix) <= 120),
  policy_version   integer NOT NULL,
  retention_days   integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  attempts         smallint NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  started_at       timestamptz,
  stop_requested_at timestamptz,
  stopped_at       timestamptz,
  available_at     timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES video_sessions (tenant_id, id),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);
-- Never two live recordings of one session, however many requests arrive at once.
CREATE UNIQUE INDEX session_recordings_live_uq ON session_recordings (session_id) WHERE status IN ('pending', 'starting', 'recording', 'stopping', 'processing');
CREATE UNIQUE INDEX session_recordings_sid_uq ON session_recordings (sid) WHERE sid IS NOT NULL;
CREATE INDEX session_recordings_session_idx ON session_recordings (tenant_id, session_id, created_at DESC);
CREATE INDEX session_recordings_work_idx ON session_recordings (tenant_id, status) WHERE status IN ('pending', 'starting', 'recording', 'stopping', 'processing');
CREATE INDEX session_recordings_expiry_idx ON session_recordings (tenant_id, expires_at) WHERE status = 'available';
SELECT apply_tenant_rls('session_recordings');
SELECT apply_updated_at('session_recordings');
REVOKE DELETE ON session_recordings FROM ah_app;

CREATE TABLE session_recording_files (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  recording_id uuid NOT NULL,
  file_key     text NOT NULL CHECK (char_length(file_key) <= 400),
  kind         text NOT NULL CHECK (kind IN ('audio', 'video', 'audio_and_video')),
  format       text NOT NULL CHECK (format IN ('mp4', 'mp3', 'm3u8', 'ts')),
  size_bytes   bigint CHECK (size_bytes >= 0),
  is_playable  boolean NOT NULL DEFAULT false,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (recording_id, file_key),
  FOREIGN KEY (tenant_id, recording_id) REFERENCES session_recordings (tenant_id, id)
);
CREATE INDEX session_recording_files_recording_idx ON session_recording_files (tenant_id, recording_id);
SELECT apply_tenant_rls('session_recording_files');
REVOKE DELETE ON session_recording_files FROM ah_app;

-- 4. Agora's notices, once each ------------------------------------------------------------------------------
CREATE TABLE recording_webhook_events (
  tenant_id    uuid NOT NULL,
  notice_id    text NOT NULL CHECK (char_length(notice_id) <= 100),
  recording_id uuid,
  event_type   integer NOT NULL,
  detail       text CHECK (detail IS NULL OR char_length(detail) <= 500),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notice_id),
  FOREIGN KEY (tenant_id, recording_id) REFERENCES session_recordings (tenant_id, id)
);
SELECT apply_tenant_rls('recording_webhook_events');
REVOKE UPDATE, DELETE ON recording_webhook_events FROM ah_app;

-- A notice names only Agora's recording id (sid); this finds the company and recording it belongs to, so the
-- notice can then be handled inside that company's own scope.
CREATE FUNCTION resolve_recording_by_sid(p_sid text) RETURNS TABLE (tenant_id uuid, recording_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT r.tenant_id, r.id FROM session_recordings r WHERE r.sid = p_sid $$;
REVOKE ALL ON FUNCTION resolve_recording_by_sid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_recording_by_sid(text) TO ah_app;

-- 5. Permissions -------------------------------------------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
  ('recording.play',     'video', 'Listen to or watch recordings of calls and meetings they may see'),
  ('recording.download', 'video', 'Download recordings of calls and meetings'),
  ('recording.manage',   'video', 'Change the recording policy: whether sessions are recorded, the notice and how long recordings are kept');
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE (r.system_key = 'super_admin' AND p.code IN ('recording.play', 'recording.download', 'recording.manage'))
   OR (r.system_key = 'admin' AND p.code IN ('recording.play', 'recording.download'))
   OR (r.system_key = 'counsellor' AND p.code = 'recording.play')
ON CONFLICT DO NOTHING;

-- 6. Notifications for the person who started the session ----------------------------------------------------------
-- (the 'communication' type already exists; the events recording_ready and recording_failed use it)

-- 7. Everyone starts with the notice the company can later change; recording stays off until a Super Admin turns it on.
INSERT INTO recording_policies (tenant_id, notice_text)
SELECT t.id, 'This session may be recorded so that it can be reviewed later by the company. By joining you agree to the recording. If you do not agree, please do not join.'
FROM tenants t
ON CONFLICT DO NOTHING;
