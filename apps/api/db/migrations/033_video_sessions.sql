-- Video counselling sessions. A counsellor opens a session for a lead; the student joins from a link
-- in the browser, no sign-in. The video itself runs on Agora; we keep only who, when and how long, so
-- the free monthly allowance can be watched. The student's link is derived from the session id with a
-- server secret (HMAC), so nothing secret is stored and the counsellor can copy the link again later.

CREATE TABLE video_sessions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  lead_id         uuid NOT NULL,
  created_by      uuid NOT NULL,
  scheduled_for   timestamptz,
  expires_at      timestamptz NOT NULL,           -- the student's link stops working after this
  max_minutes     smallint NOT NULL DEFAULT 45 CHECK (max_minutes BETWEEN 5 AND 240),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
  started_at      timestamptz,                    -- first person to join
  ended_at        timestamptz,
  ended_by        uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES users (tenant_id, id),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX video_sessions_lead_idx ON video_sessions (tenant_id, lead_id, created_at DESC);
CREATE INDEX video_sessions_started_idx ON video_sessions (tenant_id, started_at) WHERE started_at IS NOT NULL;
CREATE INDEX video_sessions_created_by_idx ON video_sessions (tenant_id, created_by);

SELECT apply_tenant_rls('video_sessions');
SELECT apply_updated_at('video_sessions');
-- Sessions are ended, not removed.
REVOKE DELETE ON video_sessions FROM ah_app;

INSERT INTO permissions (code, module, description) VALUES
  ('video.host', 'video', 'Start video counselling sessions with students and join them');

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.system_key IN ('super_admin', 'admin', 'counsellor') AND p.code = 'video.host'
ON CONFLICT DO NOTHING;
