-- 1. A lead's history can be added to, never changed or removed, by the application role. Nothing in the
--    code changes it (checked), and the audit log is already protected the same way.
REVOKE UPDATE, DELETE ON lead_activities FROM ah_app;

-- 2. Erasing a student's personal data (a student asks for it, or the law requires it).
--    The lead row stays so numbers and reports add up, but nothing that identifies the person is left:
--    name, e-mail, phone numbers, profile, education, guardians, exams, custom answers, documents, call
--    recordings, free-text notes in history, and the raw website payload. Needs lead.erase.
--    It is a SECURITY DEFINER function because the history table is closed to the application role.
--    It returns the storage keys of the files that must now be deleted from the file store.
CREATE FUNCTION erase_lead(p_lead_id uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t       uuid := current_tenant_id();
  v_no    bigint;
  v_keys  text[];
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;

  SELECT lead_no INTO v_no FROM leads WHERE id = p_lead_id AND tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(array_agg(k.file_key), '{}') INTO v_keys FROM (
    SELECT d.file_key FROM lead_documents d WHERE d.lead_id = p_lead_id AND d.tenant_id = t
    UNION ALL
    SELECT r.file_key FROM call_recordings r JOIN calls c ON c.id = r.call_id AND c.started_at = r.call_started_at
     WHERE c.lead_id = p_lead_id AND c.tenant_id = t AND r.file_key IS NOT NULL
  ) k;

  DELETE FROM lead_documents WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM call_recordings r USING calls c
   WHERE c.id = r.call_id AND c.started_at = r.call_started_at AND c.lead_id = p_lead_id AND c.tenant_id = t;
  UPDATE calls SET counterparty = '0000000000', remark = NULL WHERE lead_id = p_lead_id AND tenant_id = t;

  DELETE FROM lead_phones              WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM lead_profiles            WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM lead_education           WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM lead_guardians           WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM lead_exams               WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM lead_preferred_locations WHERE lead_id = p_lead_id AND tenant_id = t;
  DELETE FROM custom_field_values      WHERE lead_id = p_lead_id AND tenant_id = t;

  UPDATE followups        SET note = NULL           WHERE lead_id = p_lead_id AND tenant_id = t;
  UPDATE lead_shortlists  SET ni_dnp_reason = NULL  WHERE lead_id = p_lead_id AND tenant_id = t;
  UPDATE lead_enquiries   SET page_path = NULL      WHERE lead_id = p_lead_id AND tenant_id = t;
  UPDATE lead_activities  SET old_value = NULL, new_value = NULL, remark = NULL WHERE lead_id = p_lead_id AND tenant_id = t;
  UPDATE inbound_events   SET payload = '{}'::jsonb WHERE tenant_id = t AND result->>'leadId' = p_lead_id::text;

  UPDATE leads
     SET name = 'Erased', email = NULL, primary_phone = lpad(v_no::text, 10, '0'),
         interest_note = NULL, next_followup_at = NULL, deleted_at = COALESCE(deleted_at, now())
   WHERE id = p_lead_id AND tenant_id = t;

  RETURN v_keys;
END
$$;
REVOKE ALL ON FUNCTION erase_lead(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_lead(uuid) TO ah_app;

INSERT INTO permissions (code, module, description) VALUES
  ('lead.erase', 'lead', 'Permanently erase a student''s personal data');

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin' AND p.code = 'lead.erase'
ON CONFLICT DO NOTHING;

-- 3. Indexes for foreign keys that had none usable (lookups from the parent side and cascades).
CREATE INDEX lead_recommendations_college_idx   ON lead_recommendations (tenant_id, college_id);
CREATE INDEX lead_shortlists_college_idx        ON lead_shortlists (tenant_id, college_id);
CREATE INDEX lead_shortlist_courses_course_idx  ON lead_shortlist_courses (tenant_id, college_course_id);
CREATE INDEX dialer_session_leads_lead_idx      ON dialer_session_leads (tenant_id, lead_id);
CREATE INDEX leave_balances_type_idx            ON leave_balances (tenant_id, leave_type_id);
CREATE INDEX assignment_rule_users_user_idx     ON assignment_rule_users (tenant_id, user_id);
CREATE INDEX custom_field_values_def_idx        ON custom_field_values (tenant_id, def_id);
