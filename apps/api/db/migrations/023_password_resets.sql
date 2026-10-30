-- Password reset links. Only a hash of the secret is stored; a link works once and expires.
CREATE TABLE password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (tenant_id, user_id, created_at DESC);

SELECT apply_tenant_rls('password_reset_tokens');
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO ah_app;
