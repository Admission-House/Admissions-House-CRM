-- Phone alerts (push notifications).
--
-- A notification is still written to `notifications` by the code that raises it. A background job
-- then sends the ones not yet sent to the person's phones. `pushed_at` marks a notification as taken
-- by that job, so none is sent twice and none needs the 11 places that raise notifications to change.
--
-- A phone's token is tied to the sign-in (session) it was registered in. When that session ends, by
-- sign-out, inactivity or an Admin ending it, the phone stops receiving alerts, because a lead's name
-- on the lock screen of someone who is no longer signed in is a leak.
CREATE TABLE push_tokens (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  session_id   uuid NOT NULL,
  token        text NOT NULL CHECK (length(token) BETWEEN 20 AND 200),
  platform     text NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, token),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id) REFERENCES user_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX push_tokens_user_idx ON push_tokens (tenant_id, user_id);

SELECT apply_tenant_rls('push_tokens');
GRANT SELECT, INSERT, UPDATE, DELETE ON push_tokens TO ah_app;

ALTER TABLE notifications ADD COLUMN pushed_at timestamptz;
-- Everything that exists now is old news: it is never sent as an alert.
UPDATE notifications SET pushed_at = created_at;
CREATE INDEX notifications_unpushed_idx ON notifications (tenant_id, created_at) WHERE pushed_at IS NULL;
