-- Two-step sign-in (an authenticator app code after the password).
--
-- The shared secret is stored sealed (AES-GCM, see SecretBox), never in the clear. A person who is
-- still setting it up has a row with enabled_at NULL: it does nothing until they prove they can read
-- a code. last_step is the newest 30-second step already accepted, so a code cannot be used twice.
-- Recovery codes are shown once; only their hashes are kept, and each works once.
CREATE TABLE user_mfa (
  tenant_id     uuid NOT NULL,
  user_id       uuid PRIMARY KEY,
  secret_sealed text NOT NULL,
  enabled_at    timestamptz,
  last_step     bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_mfa_tenant_idx ON user_mfa (tenant_id);

CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_recovery_codes_tenant_idx ON user_recovery_codes (tenant_id);

SELECT apply_tenant_rls('user_mfa');
SELECT apply_tenant_rls('user_recovery_codes');
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa, user_recovery_codes TO ah_app;

-- A wrong two-step code is a failed sign-in, counted and logged like a wrong password.
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_result_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_result_check
  CHECK (result IN ('success', 'bad_password', 'bad_code', 'outside_office', 'device_blocked', 'locked', 'inactive'));
