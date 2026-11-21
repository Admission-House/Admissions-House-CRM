-- Calls are counted from one place, whichever way they were made:
--   phone   a call through the telephony provider (table calls)
--   app     a voice call with a lead inside the CRM (Agora; table video_sessions, kind 'voice', type 'call')
-- Calls between colleagues and video calls are not counted here: only voice calls with a student.
--
-- For an in-app voice call the student is "connected" once they joined at least once (first_joined_at: joined_at is
-- cleared again when they leave), and the talk time runs from that moment to the end of the call.
-- security_invoker makes the view run as the person asking, so each company's row-level security still applies.

CREATE VIEW call_log WITH (security_invoker = true) AS
SELECT c.tenant_id, c.id, c.user_id, c.lead_id, c.direction, c.outcome, c.duration_sec, c.started_at, c.ended_at, 'phone'::text AS via
FROM calls c
UNION ALL
SELECT v.tenant_id, v.id, v.created_by, v.lead_id, 'outgoing'::text,
       CASE WHEN g.joined_at IS NOT NULL THEN 'connected' WHEN v.status = 'ended' THEN 'not_picked' ELSE 'ringing' END,
       CASE WHEN g.joined_at IS NOT NULL AND v.ended_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM v.ended_at - g.joined_at))::integer END,
       v.created_at, v.ended_at, 'app'::text
FROM video_sessions v
LEFT JOIN LATERAL (
  SELECT min(i.first_joined_at) AS joined_at FROM video_session_invites i WHERE i.session_id = v.id AND i.kind = 'guest'
) g ON true
WHERE v.type = 'call' AND v.kind = 'voice' AND v.lead_id IS NOT NULL;

REVOKE ALL ON call_log FROM ah_app;
GRANT SELECT ON call_log TO ah_app;

-- "First called" on a lead: the first time anyone called the student, by phone or by an in-app voice call.
-- It was shown on the lead but never filled in.
CREATE FUNCTION ah_mark_first_called() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  at timestamptz;
BEGIN
  IF NEW.lead_id IS NULL THEN RETURN NULL; END IF;
  -- The two tables name the moment differently, and a record has only its own fields.
  IF TG_TABLE_NAME = 'video_sessions' THEN at := NEW.created_at; ELSE at := NEW.started_at; END IF;
  UPDATE leads SET first_called_at = at
  WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id AND (first_called_at IS NULL OR first_called_at > at);
  RETURN NULL;
END $$;

CREATE TRIGGER ah_first_called AFTER INSERT ON calls
  FOR EACH ROW WHEN (NEW.direction = 'outgoing') EXECUTE FUNCTION ah_mark_first_called();
CREATE TRIGGER ah_first_called AFTER INSERT ON video_sessions
  FOR EACH ROW WHEN (NEW.type = 'call' AND NEW.kind = 'voice') EXECUTE FUNCTION ah_mark_first_called();

-- Leads called before this change.
UPDATE leads l SET first_called_at = f.at
FROM (SELECT lead_id, min(started_at) AS at FROM call_log WHERE direction = 'outgoing' AND lead_id IS NOT NULL GROUP BY lead_id) f
WHERE f.lead_id = l.id AND (l.first_called_at IS NULL OR l.first_called_at > f.at);
