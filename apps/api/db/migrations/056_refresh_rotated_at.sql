-- When the sign-in token of a session was last renewed. Two browser tabs can renew at the same moment; the second one
-- then shows the token that was just replaced. Within a few seconds of the renewal that is the same browser, not a thief,
-- so the session is kept (see AuthService.refresh). Later, an old token still ends the session.
ALTER TABLE user_sessions ADD COLUMN refresh_rotated_at timestamptz;
