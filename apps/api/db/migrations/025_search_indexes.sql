-- Search at volume.
--
-- Found by loading 300,000 leads into one company and reading the query plans: the trigram indexes
-- on name, phone and email were never used. The API connects as a role that is subject to
-- row-level security, and PostgreSQL will not run an operator that is not "leakproof" (LIKE and
-- ILIKE are not) against an index before the tenant policy has filtered the rows. So every search
-- read every lead of the company: 170 to 300 ms at 300,000 leads, growing with the lead count. The
-- same query as the table owner takes 2 ms.
--
-- The fix keeps the isolation and moves the pattern match into two small functions that run with
-- the owner's rights (the same way find_tenant_by_slug and resolve_api_key already do). They take no
-- company as input: they read it from the transaction setting the API sets from the signed-in
-- session, and they return nothing when it is not set. They return ids only; the lead list still
-- applies the caller's row-level security and data scope when it reads those leads.

-- Email is citext; the search compares it as text, so the index is on the text form.
CREATE INDEX leads_email_trgm_idx ON leads USING gin ((email::text) gin_trgm_ops);

-- Extra phone numbers of a lead are searched by any part of the number.
CREATE INDEX lead_phones_phone_trgm_idx ON lead_phones USING gin (phone gin_trgm_ops);

-- "Leads in this status, newest first" is the most common filter on the lead list.
CREATE INDEX leads_status_created_idx ON leads (tenant_id, status_id, created_at DESC) WHERE deleted_at IS NULL;

-- Ids of the current company's leads whose name or email contains the text. p_pattern is a LIKE
-- pattern with % already around it and its own wildcards escaped.
CREATE FUNCTION lead_ids_matching_text(p_pattern text)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 200
AS $$
  SELECT l.id FROM leads l
   WHERE l.tenant_id = current_tenant_id() AND l.deleted_at IS NULL AND l.name ILIKE p_pattern
  UNION
  SELECT l.id FROM leads l
   WHERE l.tenant_id = current_tenant_id() AND l.deleted_at IS NULL AND l.email::text ILIKE p_pattern
$$;

-- Ids of the current company's leads with a phone number (main or extra) containing the digits.
CREATE FUNCTION lead_ids_matching_phone(p_pattern text)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 50
AS $$
  SELECT l.id FROM leads l
   WHERE l.tenant_id = current_tenant_id() AND l.deleted_at IS NULL AND l.primary_phone LIKE p_pattern
  UNION
  SELECT x.lead_id FROM lead_phones x
   WHERE x.tenant_id = current_tenant_id() AND x.phone LIKE p_pattern
$$;

REVOKE ALL ON FUNCTION lead_ids_matching_text(text), lead_ids_matching_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lead_ids_matching_text(text), lead_ids_matching_phone(text) TO ah_app;
