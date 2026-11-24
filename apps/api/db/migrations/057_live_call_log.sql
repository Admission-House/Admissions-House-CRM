-- The call history (Calls page, dashboard "Calls by counsellor" and "Time to first call") should change on screen as calls
-- happen, for everyone who looks at it, not only for the two people on the call. A new company-wide hint, "calllog", is
-- given whenever a call starts, connects or ends: phone calls (calls), in-app calls (video_sessions) and the moment the
-- student joins (video_session_invites.first_joined_at). It carries no data; each screen asks the API, which shows only
-- what the person may see. The existing "call" hint (ringing, per person) is unchanged.

CREATE FUNCTION ah_trg_call_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit('calllog', NEW.tenant_id, NULL);
  RETURN NULL;
END
$$;

CREATE TRIGGER ah_live_call_log_phone AFTER INSERT OR UPDATE OF outcome, ended_at ON calls
  FOR EACH ROW EXECUTE FUNCTION ah_trg_call_log();

CREATE TRIGGER ah_live_call_log_app AFTER INSERT OR UPDATE OF status, ended_at ON video_sessions
  FOR EACH ROW EXECUTE FUNCTION ah_trg_call_log();

CREATE TRIGGER ah_live_call_log_joined AFTER UPDATE OF first_joined_at ON video_session_invites
  FOR EACH ROW WHEN (OLD.first_joined_at IS NULL AND NEW.first_joined_at IS NOT NULL)
  EXECUTE FUNCTION ah_trg_call_log();
