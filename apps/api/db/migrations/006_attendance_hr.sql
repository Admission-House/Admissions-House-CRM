-- Attendance, breaks, leave and salary.

-- Settings are versioned: a new row is added when they change, so a past month can be explained.
CREATE TABLE attendance_settings (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  effective_from        date NOT NULL,
  shift_start           time NOT NULL,
  shift_end             time NOT NULL,
  grace_minutes         integer NOT NULL DEFAULT 10 CHECK (grace_minutes >= 0),
  half_day_below_hours  numeric(4, 2) NOT NULL DEFAULT 4.5 CHECK (half_day_below_hours > 0),
  idle_timeout_min      integer NOT NULL DEFAULT 30 CHECK (idle_timeout_min BETWEEN 5 AND 480),
  weekly_off_days       smallint[] NOT NULL DEFAULT '{0}',      -- 0 = Sunday ... 6 = Saturday
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, effective_from),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK (weekly_off_days <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[])
);

CREATE TABLE break_types (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  name            text NOT NULL,
  allowed_minutes integer NOT NULL CHECK (allowed_minutes > 0),
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE holidays (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  holiday_date date NOT NULL,
  name         text NOT NULL,
  UNIQUE (tenant_id, holiday_date)
);

-- One row per user per day.
CREATE TABLE attendance_records (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  user_id               uuid NOT NULL,
  work_date             date NOT NULL,             -- the day in the tenant's timezone
  branch_id             uuid,
  check_in_at           timestamptz NOT NULL,
  check_out_at          timestamptz,
  check_in_lat          numeric(9, 6),
  check_in_lng          numeric(9, 6),
  check_in_accuracy_m   numeric(8, 2) CHECK (check_in_accuracy_m >= 0),
  check_in_ip           inet,
  method                text NOT NULL CHECK (method IN ('office_check', 'exception')),
  late_minutes          integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  check_out_reason      text CHECK (check_out_reason IN ('manual', 'shift_end', 'inactivity', 'forced')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (user_id, work_date),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches (tenant_id, id),
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at),
  CHECK ((check_out_at IS NULL) = (check_out_reason IS NULL))
);
CREATE INDEX attendance_date_idx ON attendance_records (tenant_id, work_date);
CREATE INDEX attendance_open_idx ON attendance_records (tenant_id, user_id) WHERE check_out_at IS NULL;

-- Manual marks by an Admin. Kept apart from normal attendance and always shown with a label.
CREATE TABLE attendance_exceptions (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  attendance_id  uuid NOT NULL,
  requested_for  uuid NOT NULL,
  approved_by    uuid NOT NULL,
  reason         text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attendance_id),
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendance_records (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_for) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id)
);

-- A break belongs to the attendance day, which already knows the user.
CREATE TABLE break_logs (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  attendance_id  uuid NOT NULL,
  break_type_id  uuid NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  FOREIGN KEY (tenant_id, attendance_id) REFERENCES attendance_records (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, break_type_id) REFERENCES break_types (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX break_logs_attendance_idx ON break_logs (tenant_id, attendance_id);
CREATE UNIQUE INDEX break_logs_one_open_uq ON break_logs (attendance_id) WHERE ended_at IS NULL;

-- Successful and refused sign-in attempts, including attempts from outside the office.
CREATE TABLE login_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  user_id    uuid,
  result     text NOT NULL CHECK (result IN ('success', 'bad_password', 'outside_office', 'device_blocked', 'locked', 'inactive')),
  ip         inet,
  latitude   numeric(9, 6),
  longitude  numeric(9, 6),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX login_attempts_time_idx ON login_attempts (tenant_id, created_at DESC);
CREATE INDEX login_attempts_user_idx ON login_attempts (tenant_id, user_id, created_at DESC);

CREATE TABLE leave_types (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  is_paid      boolean NOT NULL DEFAULT true,
  yearly_quota numeric(4, 1) NOT NULL DEFAULT 0 CHECK (yearly_quota >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE leave_balances (
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  year          smallint NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  balance       numeric(4, 1) NOT NULL,
  PRIMARY KEY (user_id, leave_type_id, year),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id)
);

CREATE TABLE leave_requests (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  leave_type_id uuid NOT NULL,
  from_date     date NOT NULL,
  to_date       date NOT NULL,
  days          numeric(4, 1) NOT NULL CHECK (days > 0),     -- half days and holidays make this differ from the date range
  reason        text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES users (tenant_id, id),
  CHECK (to_date >= from_date),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  -- A person cannot have two live leave requests that overlap.
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  ) WHERE (status IN ('pending', 'approved'))
);
CREATE INDEX leave_requests_status_idx ON leave_requests (tenant_id, status, from_date);

-- A bulk upload of salaries, kept so a failed or wrong upload can be traced.
CREATE TABLE salary_import_batches (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  month            date NOT NULL CHECK (month = date_trunc('month', month)::date),
  uploaded_by      uuid NOT NULL,
  rows_total       integer NOT NULL CHECK (rows_total >= 0),
  rows_ok          integer NOT NULL CHECK (rows_ok >= 0),
  rows_failed      integer NOT NULL CHECK (rows_failed >= 0),
  error_report_key text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id),
  CHECK (rows_ok + rows_failed = rows_total)
);

-- One salary record per employee per month. Entered by people, as in SmartCRM; never calculated
-- from attendance. net_pay is generated by the database so it cannot disagree with its inputs.
CREATE TABLE salary_records (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,
  month            date NOT NULL CHECK (month = date_trunc('month', month)::date),
  base_pay         numeric(12, 2) NOT NULL CHECK (base_pay >= 0),
  allowances       numeric(12, 2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  deductions       numeric(12, 2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  net_pay          numeric(12, 2) GENERATED ALWAYS AS (base_pay + allowances - deductions) STORED,
  notes            text,
  payslip_file_key text,
  batch_id         uuid,
  entered_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, month),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, entered_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES salary_import_batches (tenant_id, id)
);
CREATE INDEX salary_month_idx ON salary_records (tenant_id, month);
