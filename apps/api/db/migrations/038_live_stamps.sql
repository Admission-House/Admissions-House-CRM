-- Live updates without a long-lived connection. The triggers already say "something changed" with a
-- NOTIFY (migration 030), which only reaches a browser that is connected by WebSocket. Where a
-- WebSocket cannot be kept (Vercel), the browser asks a small question instead ("what changed since
-- last time?"), and the answer is the time of the last change per topic. Writing that time here, from
-- the same function the triggers already call, means every place that changes the data is covered, and
-- the question is answered by reading a few tiny rows, never by counting a big table.
CREATE TABLE live_stamps (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  topic     text NOT NULL,
  -- The person a hint is for (a notification, a ring), or all zeros when it is for the whole company.
  scope     uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  bumped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, topic, scope)
);
SELECT apply_tenant_rls('live_stamps');
GRANT SELECT, INSERT, UPDATE ON live_stamps TO ah_app;

CREATE OR REPLACE FUNCTION ah_emit(p_topic text, p_tenant uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('ah_events', json_build_object('t', p_tenant, 'topic', p_topic, 'u', p_user)::text);
  BEGIN
    -- Once per transaction is enough: a bulk import is one change, not one per row (now() is the start of the transaction).
    INSERT INTO live_stamps (tenant_id, topic, scope)
    VALUES (p_tenant, p_topic, COALESCE(p_user, '00000000-0000-0000-0000-000000000000'::uuid))
    ON CONFLICT (tenant_id, topic, scope) DO UPDATE SET bumped_at = clock_timestamp() WHERE live_stamps.bumped_at < now();
  EXCEPTION WHEN OTHERS THEN
    -- The stamp is a convenience. Whatever it fails on (for example a write made with no company set), the change itself must go through.
    NULL;
  END;
END
$$;
