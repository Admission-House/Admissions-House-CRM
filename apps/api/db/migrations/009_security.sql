-- Row-level security, application role rights and updated_at triggers.

-- 1. Every table that has a tenant_id is limited to the current tenant. Partitions are skipped on
--    purpose: the policy lives on the parent and partitions are not reachable by the app role.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    PERFORM apply_tenant_rls(r.tbl);
  END LOOP;
END
$$;

-- The tenants table has no tenant_id; a request can see only its own company.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

-- 2. updated_at is maintained by the database, not by application code.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
  LOOP
    PERFORM apply_updated_at(r.tbl);
  END LOOP;
END
$$;

-- 3. Rights of the application role. Start from nothing and grant what is needed.
GRANT USAGE ON SCHEMA public TO ah_app;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.relname <> 'schema_migrations'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO ah_app', r.tbl);
  END LOOP;
END
$$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ah_app;

-- Shared reference data: read only.
REVOKE INSERT, UPDATE, DELETE ON locations, permissions FROM ah_app;
-- The audit log can be written and read, never changed.
REVOKE UPDATE, DELETE ON audit_logs FROM ah_app;
-- A company row is changed from settings only; the app can never create or remove one.
REVOKE INSERT, DELETE ON tenants FROM ah_app;
-- Business records are soft-deleted or corrected, not removed.
REVOKE DELETE ON leads, users, calls, attendance_records, salary_records, salary_import_batches FROM ah_app;

-- Tables made by later migrations get the same default; they must still call apply_tenant_rls().
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ah_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ah_app;

-- 4. Functions. Maintenance helpers stay with the owner; the app gets only what it calls.
REVOKE ALL ON FUNCTION apply_tenant_rls(regclass), apply_updated_at(regclass),
                       create_month_partition(regclass, date), ensure_partitions(integer),
                       find_tenant_by_slug(text), resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_tenant_id(), next_counter(text), find_tenant_by_slug(text),
                          resolve_api_key(text), ensure_partitions(integer) TO ah_app;
