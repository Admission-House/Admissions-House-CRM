-- Payroll that is calculated: a policy (versioned, like the attendance settings), a salary structure per
-- employee (versioned by month), a payroll run per month with a payslip per employee, and the lines of
-- each payslip. Approving a run copies each payslip into salary_records, so My salary, the monthly
-- report and the PDF keep working from one place.

CREATE TABLE payroll_policies (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                  uuid NOT NULL REFERENCES tenants (id),
  effective_from             date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  -- How the pay of one day is found: base pay / calendar days, or base pay / working days.
  working_days_basis         text NOT NULL DEFAULT 'working' CHECK (working_days_basis IN ('calendar', 'working')),
  -- Late arrivals (already measured against the shift start plus grace by the attendance rules).
  late_free_per_month        smallint NOT NULL DEFAULT 3 CHECK (late_free_per_month BETWEEN 0 AND 31),
  late_penalty_days          numeric(4, 2) NOT NULL DEFAULT 0.25 CHECK (late_penalty_days BETWEEN 0 AND 5),
  -- A day worked for fewer hours than the attendance setting counts as a half day.
  half_day_deduction_days    numeric(4, 2) NOT NULL DEFAULT 0.50 CHECK (half_day_deduction_days BETWEEN 0 AND 1),
  -- A working day with no attendance and no approved leave.
  absent_deduction_days      numeric(4, 2) NOT NULL DEFAULT 1.00 CHECK (absent_deduction_days BETWEEN 0 AND 5),
  -- A day on approved leave of a leave type that is not paid.
  unpaid_leave_deduction_days numeric(4, 2) NOT NULL DEFAULT 1.00 CHECK (unpaid_leave_deduction_days BETWEEN 0 AND 5),
  -- Rupees taken for each minute a break ran over its allowance. 0 switches the rule off.
  break_overrun_per_minute   numeric(8, 2) NOT NULL DEFAULT 0 CHECK (break_overrun_per_minute BETWEEN 0 AND 100000),
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, effective_from),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE salary_structures (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  user_id        uuid NOT NULL,
  effective_from date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  base_pay       numeric(12, 2) NOT NULL CHECK (base_pay >= 0),
  notes          text,
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (user_id, effective_from),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE salary_structure_lines (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  structure_id uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('allowance', 'deduction')),
  label        text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  amount       numeric(12, 2) NOT NULL CHECK (amount > 0),
  position     smallint NOT NULL DEFAULT 0,
  UNIQUE (structure_id, kind, label),
  FOREIGN KEY (tenant_id, structure_id) REFERENCES salary_structures (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE payroll_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  month           date NOT NULL CHECK (month = date_trunc('month', month)::date),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  -- The policy as it was when the run was calculated, so a past month can always be explained.
  policy          jsonb NOT NULL,
  generated_by    uuid NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  approved_by     uuid,
  approved_at     timestamptz,
  reopened_count  integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, month),
  FOREIGN KEY (tenant_id, generated_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE payslips (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL,
  run_id             uuid NOT NULL,
  user_id            uuid NOT NULL,
  month              date NOT NULL,
  -- What the month looked like for this person (for the screen and the PDF).
  basis_days         numeric(5, 1) NOT NULL,
  working_days       numeric(5, 1) NOT NULL,
  present_days       numeric(5, 1) NOT NULL,
  paid_leave_days    numeric(5, 1) NOT NULL,
  unpaid_leave_days  numeric(5, 1) NOT NULL,
  absent_days        numeric(5, 1) NOT NULL,
  half_days          numeric(5, 1) NOT NULL,
  late_count         integer NOT NULL,
  break_over_minutes integer NOT NULL,
  daily_rate         numeric(12, 2) NOT NULL,
  -- Totals are kept in step with the lines by the service, in one transaction.
  gross              numeric(12, 2) NOT NULL DEFAULT 0,
  deductions         numeric(12, 2) NOT NULL DEFAULT 0,
  net_pay            numeric(12, 2) GENERATED ALWAYS AS (gross - deductions) STORED,
  adjusted           boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (run_id, user_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES payroll_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX payslips_user_idx ON payslips (tenant_id, user_id, month DESC);

CREATE TABLE payslip_lines (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  payslip_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('earning', 'deduction')),
  label           text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  amount          numeric(12, 2) NOT NULL CHECK (amount >= 0),
  -- The amount the rules calculated. It differs from amount only after someone adjusted the line.
  calculated      numeric(12, 2) NOT NULL CHECK (calculated >= 0),
  source          text NOT NULL CHECK (source IN ('structure', 'attendance', 'adjustment')),
  detail          text,
  reason          text,
  adjusted_by     uuid,
  adjusted_at     timestamptz,
  position        smallint NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, payslip_id) REFERENCES payslips (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, adjusted_by) REFERENCES users (tenant_id, id),
  -- An adjustment, or a line whose amount was changed, always says why.
  CHECK (source <> 'adjustment' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  CHECK (amount = calculated OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);
CREATE INDEX payslip_lines_idx ON payslip_lines (tenant_id, payslip_id, position);

-- A salary record that came from a payroll run points back to its payslip, and is shown to people only
-- while that run is approved. Reopening a run hides the records again instead of deleting them.
ALTER TABLE salary_records
  ADD COLUMN payslip_id uuid,
  ADD COLUMN is_live    boolean NOT NULL DEFAULT true,
  -- Rebuilding a draft run deletes its payslips; the record then simply loses the link (it stays hidden until the next approval).
  ADD FOREIGN KEY (tenant_id, payslip_id) REFERENCES payslips (tenant_id, id) ON DELETE SET NULL (payslip_id);

-- Row-level security and rights, in the same way as the other company tables.
SELECT apply_tenant_rls('payroll_policies');
SELECT apply_tenant_rls('salary_structures');
SELECT apply_tenant_rls('salary_structure_lines');
SELECT apply_tenant_rls('payroll_runs');
SELECT apply_tenant_rls('payslips');
SELECT apply_tenant_rls('payslip_lines');
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_policies, salary_structures, salary_structure_lines, payroll_runs, payslips, payslip_lines TO ah_app;
-- History that must stay: nobody deletes a policy or a run through the application. Payslips of a draft run
-- can be rebuilt; the trigger below stops any change once the run is approved.
REVOKE DELETE ON payroll_policies, payroll_runs FROM ah_app;

-- Once a run is approved, its payslips and their lines cannot be inserted, changed or deleted, whatever the
-- application does. Reopening the run first is the only way, and that is logged by the application.
CREATE FUNCTION payroll_run_is_approved(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE id = p_run AND status = 'approved') $$;

CREATE FUNCTION payslips_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF payroll_run_is_approved(CASE WHEN TG_OP = 'INSERT' THEN NEW.run_id ELSE OLD.run_id END) THEN
    RAISE EXCEPTION 'PAYROLL_APPROVED: payslips of an approved run cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER payslips_guard BEFORE INSERT OR UPDATE OR DELETE ON payslips FOR EACH ROW EXECUTE FUNCTION payslips_guard();

CREATE FUNCTION payslip_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_run uuid;
BEGIN
  SELECT run_id INTO v_run FROM payslips WHERE id = CASE WHEN TG_OP = 'INSERT' THEN NEW.payslip_id ELSE OLD.payslip_id END;
  -- The payslip row may already be gone (the run is being rebuilt); that is only possible for a draft run.
  IF v_run IS NOT NULL AND payroll_run_is_approved(v_run) THEN
    RAISE EXCEPTION 'PAYROLL_APPROVED: payslips of an approved run cannot be changed' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER payslip_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON payslip_lines FOR EACH ROW EXECUTE FUNCTION payslip_lines_guard();

-- New permissions: setting the policy and calculating a run, and approving or reopening it.
INSERT INTO permissions (code, module, description) VALUES
  ('payroll.manage',  'salary', 'Set the payroll policy and calculate a payroll run'),
  ('payroll.approve', 'salary', 'Approve or reopen a payroll run');

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin' AND p.code IN ('payroll.manage', 'payroll.approve')
ON CONFLICT DO NOTHING;
