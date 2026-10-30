-- Configuration each tenant controls, and master data for colleges and courses.

CREATE TABLE lead_statuses (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  name              text NOT NULL,
  queue             text NOT NULL CHECK (queue IN ('fresh', 'missed', 'followup', 'counselled', 'fee_paid', 'closed')),
  is_open           boolean NOT NULL DEFAULT true,
  requires_followup boolean NOT NULL DEFAULT false,
  sort_order        integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE lead_substatuses (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  status_id  uuid NOT NULL,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (status_id, name),
  FOREIGN KEY (tenant_id, status_id) REFERENCES lead_statuses (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE lead_sources (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  name         text NOT NULL,
  channel_type text NOT NULL CHECK (channel_type IN ('website', 'ads', 'portal', 'call', 'referral', 'walk_in', 'import', 'other')),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- States and cities are the same for every company, so this table has no tenant_id and the
-- application can only read it. A city has a state as its parent.
CREATE TABLE locations (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  parent_id uuid REFERENCES locations (id),
  type      text NOT NULL CHECK (type IN ('state', 'city')),
  name      text NOT NULL,
  CHECK ((type = 'state') = (parent_id IS NULL))
);
CREATE UNIQUE INDEX locations_name_uq ON locations (type, name, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX locations_parent_idx ON locations (parent_id);
CREATE INDEX locations_name_trgm_idx ON locations USING gin (name gin_trgm_ops);

-- Fields of study such as Engineering or Management. Courses and student preferences point here.
CREATE TABLE streams (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name      text NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE courses (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,                       -- for example B.Sc Nursing
  level      text NOT NULL CHECK (level IN ('UG', 'PG', 'Diploma')),
  stream_id  uuid,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, stream_id) REFERENCES streams (tenant_id, id)
);
CREATE INDEX courses_stream_idx ON courses (tenant_id, stream_id);

CREATE TABLE colleges (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  location_id uuid REFERENCES locations (id),
  is_active   boolean NOT NULL DEFAULT true,
  is_manual   boolean NOT NULL DEFAULT false,     -- added by a counsellor, waits for Admin review
  created_by  uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name, location_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES users (tenant_id, id),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX colleges_location_idx ON colleges (tenant_id, location_id);
CREATE INDEX colleges_review_idx ON colleges (tenant_id) WHERE is_manual AND reviewed_at IS NULL;
CREATE INDEX colleges_name_trgm_idx ON colleges USING gin (name gin_trgm_ops);

-- Which college offers which course. Fees and delivery mode belong to the pair, not to either side.
CREATE TABLE college_courses (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  college_id     uuid NOT NULL,
  course_id      uuid NOT NULL,
  caf_fee        numeric(12, 2) CHECK (caf_fee >= 0),
  annual_fee     numeric(12, 2) CHECK (annual_fee >= 0),
  duration_years numeric(3, 1) CHECK (duration_years > 0),
  delivery_mode  text NOT NULL CHECK (delivery_mode IN ('online', 'regular', 'both')),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (college_id, course_id),
  FOREIGN KEY (tenant_id, college_id) REFERENCES colleges (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id)
);
CREATE INDEX college_courses_course_idx ON college_courses (tenant_id, course_id, delivery_mode);

-- Extra fields a tenant wants on leads.
CREATE TABLE custom_field_defs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  entity      text NOT NULL DEFAULT 'lead' CHECK (entity IN ('lead')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label       text NOT NULL,
  data_type   text NOT NULL CHECK (data_type IN ('text', 'number', 'date', 'select')),
  is_required boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity, key)
);

CREATE TABLE custom_field_options (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  def_id     uuid NOT NULL,
  value      text NOT NULL,
  label      text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE (def_id, value),
  FOREIGN KEY (tenant_id, def_id) REFERENCES custom_field_defs (tenant_id, id) ON DELETE CASCADE
);

-- Automatic assignment. A NULL condition means "any". Rules run in priority order.
CREATE TABLE assignment_rules (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  priority    integer NOT NULL,
  source_id   uuid,
  course_id   uuid,
  location_id uuid REFERENCES locations (id),
  study_mode  text CHECK (study_mode IN ('online', 'regular')),
  strategy    text NOT NULL CHECK (strategy IN ('round_robin', 'least_busy', 'fixed')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, priority),
  FOREIGN KEY (tenant_id, source_id) REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES courses (tenant_id, id)
);

CREATE TABLE assignment_rule_users (
  tenant_id uuid NOT NULL,
  rule_id   uuid NOT NULL,
  user_id   uuid NOT NULL,
  PRIMARY KEY (rule_id, user_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES assignment_rules (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- Per-tenant lead handling choices. One row per tenant.
CREATE TABLE lead_policies (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants (id),
  duplicate_action text NOT NULL DEFAULT 'attach' CHECK (duplicate_action IN ('reject', 'attach')),
  auto_assign      boolean NOT NULL DEFAULT true,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
