-- A session made while the policy wanted a recording but the server could not make one says so, instead of
-- looking like a session that was never meant to be recorded.
ALTER TABLE video_sessions ADD COLUMN recording_unavailable boolean NOT NULL DEFAULT false;
