-- Monthly partitions for the four tables that only grow: lead_activities, calls, notifications,
-- audit_logs.
--
-- The application role is given rights on the parent table only. Row-level security is defined on
-- the parent, so a partition must never be reachable directly; create_month_partition revokes
-- access to every partition it makes.

CREATE FUNCTION create_month_partition(p_parent regclass, p_month date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_name  text := format('%s_%s', (SELECT relname FROM pg_class WHERE oid = p_parent), to_char(v_start, 'YYYYMM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
    v_name, p_parent, v_start, (v_start + interval '1 month')::date);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, ah_app', v_name);
END
$$;

-- Creates the partitions from last month up to p_months_ahead months from now. Safe to run often;
-- a daily job calls it so the next months always exist before data arrives for them.
CREATE FUNCTION ensure_partitions(p_months_ahead integer DEFAULT 12) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent text;
  v_i      integer;
  v_count  integer := 0;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['lead_activities', 'calls', 'notifications', 'audit_logs'] LOOP
    FOR v_i IN -1 .. p_months_ahead LOOP
      PERFORM create_month_partition(v_parent::regclass, (date_trunc('month', now()) + make_interval(months => v_i))::date);
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END
$$;

-- A catch-all partition per table, so an unexpected timestamp never makes an insert fail.
-- ensure_partitions must stay ahead of the calendar, because a month cannot be created while the
-- default partition already holds rows for it.
DO $$
DECLARE v_parent text;
BEGIN
  FOREACH v_parent IN ARRAY ARRAY['lead_activities', 'calls', 'notifications', 'audit_logs'] LOOP
    EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', v_parent || '_default', v_parent);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, ah_app', v_parent || '_default');
  END LOOP;
END
$$;

SELECT ensure_partitions(12);
