-- Support for sign-in: which kind of client a session belongs to, and a fast look-up for
-- throttling repeated attempts from one address.

ALTER TABLE user_sessions
  ADD COLUMN client_type text NOT NULL DEFAULT 'web' CHECK (client_type IN ('web', 'mobile'));

CREATE INDEX login_attempts_ip_idx ON login_attempts (tenant_id, ip, created_at DESC);
