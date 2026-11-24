-- Calls made from the counsellor's own mobile (no calling provider): the CRM cannot see them, so the counsellor writes
-- down the result after the call (connected for how long, not picked, busy, switched off, or a missed call from the
-- student). They are stored with the other phone calls so "Calls today", "Missed calls today", the Calls page and the
-- reports count them; `logged_by_hand` keeps them apart from calls a provider reported, and the call history shows them
-- as "manual". The after-call form is not asked for again: the counsellor disposes the lead on the lead page.

ALTER TABLE calls ADD COLUMN logged_by_hand boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW call_log WITH (security_invoker = true) AS
SELECT c.tenant_id, c.id, c.user_id, c.lead_id, c.direction, c.outcome, c.duration_sec, c.started_at, c.ended_at,
       CASE WHEN c.logged_by_hand THEN 'manual' ELSE 'phone' END::text AS via
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
