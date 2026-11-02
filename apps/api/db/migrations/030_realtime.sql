-- Live updates. When something a screen shows has changed, the database says so on the `ah_events`
-- channel and every API server passes a small hint to the browsers that are connected to it.
--
-- A hint carries no data: only the company, a topic and, for some topics, a person. The browser
-- then asks for the new numbers through the normal API, so nothing can reach it that its permissions
-- do not allow. Doing it in triggers means every place that changes these tables is covered, with
-- no code to remember, and it works across several API servers without a message broker.
-- NOTIFY is delivered only when the transaction commits, and identical hints inside one transaction
-- are sent once, so a bulk import is one hint per person, not one per row.
CREATE FUNCTION ah_emit(p_topic text, p_tenant uuid, p_user uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_notify('ah_events', json_build_object('t', p_tenant, 'topic', p_topic, 'u', p_user)::text)
$$;

-- A new notification: the person it is for.
CREATE FUNCTION ah_trg_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit('notification', NEW.tenant_id, NEW.user_id);
  RETURN NULL;
END
$$;
CREATE TRIGGER ah_live_notification AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION ah_trg_notification();

-- Who is working right now changes when someone signs in or out, starts or ends a call, or starts or
-- ends a break.
CREATE FUNCTION ah_trg_team() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit('team', NEW.tenant_id, NULL);
  RETURN NULL;
END
$$;
CREATE TRIGGER ah_live_team_sessions AFTER INSERT OR UPDATE OF ended_at ON user_sessions
  FOR EACH ROW EXECUTE FUNCTION ah_trg_team();
CREATE TRIGGER ah_live_team_calls AFTER INSERT OR UPDATE OF outcome, ended_at ON calls
  FOR EACH ROW EXECUTE FUNCTION ah_trg_team();
CREATE TRIGGER ah_live_team_breaks AFTER INSERT OR UPDATE OF ended_at ON break_logs
  FOR EACH ROW EXECUTE FUNCTION ah_trg_team();

-- A lead was added, given to someone, or changed status: the person who holds it, and the one who held it before.
CREATE FUNCTION ah_trg_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit('lead', NEW.tenant_id, NEW.assigned_to);
  IF TG_OP = 'UPDATE' AND OLD.assigned_to IS DISTINCT FROM NEW.assigned_to AND OLD.assigned_to IS NOT NULL THEN
    PERFORM ah_emit('lead', NEW.tenant_id, OLD.assigned_to);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER ah_live_lead AFTER INSERT OR UPDATE OF status_id, assigned_to ON leads
  FOR EACH ROW EXECUTE FUNCTION ah_trg_lead();
