-- A session is either a video call or a voice call, and more than two people may join (a team meeting).
-- Voice costs a quarter of video in Agora's minutes, and every extra person adds to the count, so the
-- monthly estimate needs to know the kind and how many different people joined.

ALTER TABLE video_sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'video' CHECK (kind IN ('video', 'voice'));

-- Who joined a session: 'guest' for the student (however many devices) or 'user:<id>' for a staff member.
CREATE TABLE video_session_people (
  tenant_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  person     text NOT NULL CHECK (person = 'guest' OR person ~ '^user:[0-9a-f-]{36}$'),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, person),
  FOREIGN KEY (tenant_id, session_id) REFERENCES video_sessions (tenant_id, id)
);
CREATE INDEX video_session_people_tenant_idx ON video_session_people (tenant_id, session_id);

SELECT apply_tenant_rls('video_session_people');
REVOKE DELETE, UPDATE ON video_session_people FROM ah_app;
