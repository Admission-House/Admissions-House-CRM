-- System tables: notifications, audit log, intake keys and raw inbound events.

CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  type       text NOT NULL CHECK (type IN ('followup_due', 'assignment', 'approval', 'security', 'lead_new', 'system')),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;

-- Append only. The application role gets INSERT and SELECT on it, never UPDATE or DELETE.
CREATE TABLE audit_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  uuid NOT NULL,
  actor_id   uuid,
  action     text NOT NULL,                        -- for example salary.update
  entity     text NOT NULL,
  entity_id  uuid,
  before     jsonb,
  after      jsonb,
  ip         inet,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX audit_logs_time_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (tenant_id, actor_id, created_at DESC);

-- A key lets one lead source (the website, an ad platform) call the intake API.
-- Only a SHA-256 hash is stored; the key itself is shown once when it is created.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  source_id    uuid NOT NULL,
  name         text NOT NULL,
  key_prefix   text NOT NULL,                      -- first characters, so people can tell keys apart
  key_hash     text NOT NULL UNIQUE,
  created_by   uuid,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX api_keys_source_idx ON api_keys (tenant_id, source_id);

-- Raw webhook and intake events, stored before they are processed. The unique key makes a retried
-- delivery harmless.
CREATE TABLE inbound_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  provider     text NOT NULL,                      -- website, meta_ads, google_ads, dialer, ...
  external_id  text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  error        text,
  attempts     smallint NOT NULL DEFAULT 0,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, provider, external_id)
);
CREATE INDEX inbound_events_pending_idx ON inbound_events (received_at) WHERE status IN ('received', 'failed');

-- The two lookups that must work before a tenant is known. They run with the rights of the table
-- owner and return only what the caller needs, so the tables themselves stay closed.
CREATE FUNCTION find_tenant_by_slug(p_slug text)
RETURNS TABLE (id uuid, name text, status text, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT t.id, t.name, t.status, t.timezone FROM tenants t WHERE t.slug = p_slug::citext $$;

CREATE FUNCTION resolve_api_key(p_key_hash text)
RETURNS TABLE (api_key_id uuid, tenant_id uuid, source_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE api_keys k SET last_used_at = now()
  FROM tenants t
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL
    AND t.id = k.tenant_id AND t.status = 'active'
  RETURNING k.id, k.tenant_id, k.source_id
$$;
