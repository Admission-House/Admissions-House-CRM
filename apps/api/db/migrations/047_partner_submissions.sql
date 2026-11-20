-- Sending a lead to a partner college (the college's own API takes the student's details). Each attempt is kept: what was sent
-- (never the college's secret key), whether the college accepted it, and what it answered, so a counsellor can see that a lead
-- has already gone and nobody sends the same student twice by accident.
CREATE TABLE lead_partner_submissions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  lead_id      uuid NOT NULL,
  partner      text NOT NULL CHECK (partner ~ '^[a-z0-9-]{2,40}$'),
  request      jsonb NOT NULL,
  ok           boolean NOT NULL,
  http_status  integer,
  response     text,
  submitted_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX lead_partner_submissions_lead_idx ON lead_partner_submissions (tenant_id, lead_id, created_at DESC);
SELECT apply_tenant_rls('lead_partner_submissions');
GRANT SELECT, INSERT ON lead_partner_submissions TO ah_app;
CREATE TRIGGER ah_live_lead AFTER INSERT OR UPDATE OR DELETE ON lead_partner_submissions
  FOR EACH ROW EXECUTE FUNCTION ah_trg_topic('lead');

-- The history of a lead gets its own kind of entry for this.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'lead_activities'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status_change%' LOOP
    EXECUTE format('ALTER TABLE lead_activities DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
ALTER TABLE lead_activities ADD CONSTRAINT lead_activities_type_check
  CHECK (type IN ('note', 'status_change', 'assignment', 'call', 'document', 'shortlist', 'enquiry', 'field_change', 'followup', 'partner'));

-- Erasing a student's personal data must also remove the copy sent along with a submission.
CREATE OR REPLACE FUNCTION erase_lead(p_lead_id uuid) RETURNS text[]
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
  DELETE FROM lead_partner_submissions WHERE lead_id = p_lead_id AND tenant_id = t;

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
