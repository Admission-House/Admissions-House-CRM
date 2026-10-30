-- Telephony. One connection per company: which provider, the key the provider uses to call us, and
-- the credentials we use to call the provider (stored encrypted by the application).

CREATE TABLE telephony_connections (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants (id),
  provider           text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,40}$'),
  webhook_key_prefix text NOT NULL,                  -- first characters, so people can tell keys apart
  webhook_key_hash   text NOT NULL UNIQUE,           -- sha256 of the key the provider sends with each event
  config_enc         text,                           -- provider credentials, encrypted (v1.iv.tag.ciphertext)
  recording_hosts    text[] NOT NULL DEFAULT '{}',   -- the only hosts recordings may be downloaded from
  is_enabled         boolean NOT NULL DEFAULT false,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

SELECT apply_tenant_rls('telephony_connections');
SELECT apply_updated_at('telephony_connections');

-- The provider calls us before any company is known, so the key is resolved the same way as an
-- intake key: a narrow function with the table owner's rights.
CREATE FUNCTION resolve_telephony_key(p_key_hash text)
RETURNS TABLE (tenant_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.provider
  FROM telephony_connections c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.webhook_key_hash = p_key_hash AND c.is_enabled AND t.status = 'active'
$$;
REVOKE ALL ON FUNCTION resolve_telephony_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_telephony_key(text) TO ah_app;

-- What the agent does after a call.
ALTER TABLE calls
  ADD COLUMN remark         text CHECK (char_length(remark) <= 2000),
  ADD COLUMN wrapped_up_at  timestamptz,
  ADD COLUMN wrapped_up_by  uuid;

-- A recording is fetched from the provider after the call ends, so it has a state of its own.
ALTER TABLE call_recordings
  ALTER COLUMN file_key DROP NOT NULL,
  ADD COLUMN source_url  text,
  ADD COLUMN status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'failed')),
  ADD COLUMN size_bytes  integer CHECK (size_bytes >= 0),
  ADD COLUMN attempts    smallint NOT NULL DEFAULT 0,
  ADD COLUMN last_error  text,
  ADD CONSTRAINT call_recordings_stored_has_file CHECK (status <> 'stored' OR file_key IS NOT NULL);
CREATE UNIQUE INDEX call_recordings_one_per_call ON call_recordings (tenant_id, call_id);
CREATE INDEX call_recordings_pending_idx ON call_recordings (created_at) WHERE status = 'pending';
