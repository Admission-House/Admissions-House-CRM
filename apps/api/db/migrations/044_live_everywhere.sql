-- Live updates for every screen, not only the dashboard. Until now only a few changes said "something changed":
-- a lead's status or holder, a sign-in, a break, a call and a new notification. A lead's notes, follow-ups and details,
-- attendance and leave, salary runs and the company's own settings (people, roles, branches, statuses) changed
-- quietly, so another person's screen stayed old until it was refreshed by hand.
--
-- Three company-wide topics are added and `lead` now covers everything about a lead:
--   lead   any change to a lead or to what hangs off it (notes, follow-ups, phones, documents ...)
--   work   attendance, breaks, leave and pay
--   admin  people, roles, branches, networks, lead statuses and sources, break kinds, attendance rules
-- A hint carries no data. The screen asks the normal API again, so nobody sees more than their permissions allow.

CREATE FUNCTION ah_trg_topic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit(TG_ARGV[0], CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END, NULL);
  RETURN NULL;
END
$$;

-- A lead: any change at all (before, only status and holder), and for the whole company, because a supervisor
-- watching the list needs to hear about a lead that belongs to someone else.
CREATE OR REPLACE FUNCTION ah_trg_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ah_emit('lead', CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END, NULL);
  RETURN NULL;
END
$$;
DROP TRIGGER ah_live_lead ON leads;
CREATE TRIGGER ah_live_lead AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION ah_trg_lead();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_activities', 'followups', 'lead_profiles', 'lead_phones', 'lead_documents', 'lead_education', 'lead_guardians',
                           'lead_exams', 'lead_enquiries', 'lead_recommendations', 'lead_shortlists'] LOOP
    EXECUTE format('CREATE TRIGGER ah_live_lead AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ah_trg_topic(%L)', t, 'lead');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['attendance_records', 'attendance_exceptions', 'break_logs', 'leave_requests', 'leave_balances', 'payroll_runs',
                           'payslips', 'salary_structures'] LOOP
    EXECUTE format('CREATE TRIGGER ah_live_work AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ah_trg_topic(%L)', t, 'work');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['users', 'user_profiles', 'roles', 'role_permissions', 'branches', 'branch_networks', 'lead_statuses', 'lead_substatuses',
                           'lead_sources', 'break_types', 'attendance_settings', 'leave_types'] LOOP
    EXECUTE format('CREATE TRIGGER ah_live_admin AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ah_trg_topic(%L)', t, 'admin');
  END LOOP;
END
$$;
