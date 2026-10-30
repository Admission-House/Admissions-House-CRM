-- Foundation: extensions and helpers used by every later migration.

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fast partial search on names and phones
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints (no overlapping leave)

-- The tenant of the current request. The API sets it with SET LOCAL app.tenant_id = '<uuid>'.
-- Returns NULL when it is not set, so every row-level-security policy then matches nothing.
CREATE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Turns on row-level security for a table and restricts it to the current tenant.
-- FORCE makes the policy apply to the table owner as well; only superusers skip it.
CREATE FUNCTION apply_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s
       USING (tenant_id = current_tenant_id())
       WITH CHECK (tenant_id = current_tenant_id())', tbl);
END
$$;

-- Keeps updated_at current on a table.
CREATE FUNCTION apply_updated_at(tbl regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON %s', tbl);
  EXECUTE format(
    'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %s
       FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl);
END
$$;
