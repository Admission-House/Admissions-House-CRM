-- What each person sets for themselves: a small profile photo, the page they land on after signing in, and
-- which kinds of alerts they want. One row per person, made when they first save something. The photo is kept
-- here as a small image (the browser shrinks it first) rather than in file storage, so it works anywhere the
-- database does, and it is limited to 64 KB so a profile can never become a way to fill the database.
CREATE TABLE user_preferences (
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  start_page        text CHECK (start_page IN ('dashboard', 'leads', 'followups', 'communications', 'reports', 'attendance')),
  -- {"leads": false} means this person does not want that kind of alert. A kind that is missing is wanted.
  notify            jsonb NOT NULL DEFAULT '{}'::jsonb,
  avatar            bytea,
  avatar_type       text CHECK (avatar_type IN ('image/jpeg', 'image/png', 'image/webp')),
  avatar_updated_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CHECK (avatar IS NULL OR octet_length(avatar) <= 65536),
  CHECK ((avatar IS NULL) = (avatar_type IS NULL)),
  CHECK (jsonb_typeof(notify) = 'object')
);
SELECT apply_tenant_rls('user_preferences');
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO ah_app;
