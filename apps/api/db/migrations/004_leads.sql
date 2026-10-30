-- Leads and everything that hangs off a lead.

-- Per-tenant counters, used for the Lead ID shown to users (LEAD-1001 style numbers).
CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name      text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, name)
);

-- Returns the next number of a counter. The row lock makes it safe for concurrent inserts.
CREATE FUNCTION next_counter(p_name text) RETURNS bigint
LANGUAGE sql
AS $$
  INSERT INTO tenant_counters (tenant_id, name, value)
  VALUES (current_tenant_id(), p_name, 1)
  ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1
  RETURNING value
$$;

CREATE TABLE leads (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  lead_no                 bigint NOT NULL,
  name                    text NOT NULL CHECK (length(btrim(name)) > 0),
  email                   citext CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  primary_phone           text NOT NULL CHECK (primary_phone ~ '^[0-9]{8,15}$'),   -- country code + digits
  status_id               uuid NOT NULL,
  substatus_id            uuid,
  source_id               uuid NOT NULL,
  study_mode              text CHECK (study_mode IN ('online', 'regular')),
  intent                  text CHECK (intent IN ('hot', 'warm', 'cold')),
  expected_closure_on     date,
  assigned_to             uuid,
  assigned_at             timestamptz,
  next_followup_at        timestamptz,            -- the one deliberate copy, kept by the follow-up service
  first_called_at         timestamptz,
  interested_course_id    uuid,
  interested_location_id  uuid REFERENCES locations (id),
  interest_note           text,                   -- free text from forms, e.g. "B.Tech at XYZ University"
  deleted_at              timestamptz,
  created_by              uuid,
  updated_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, lead_no),
  FOREIGN KEY (tenant_id, status_id) REFERENCES lead_statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, substatus_id) REFERENCES lead_substatuses (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, interested_course_id) REFERENCES courses (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id),
  CHECK ((assigned_to IS NULL) = (assigned_at IS NULL))
);
-- One live lead per phone number. A repeat enquiry becomes a lead_enquiries row instead.
CREATE UNIQUE INDEX leads_phone_uq ON leads (tenant_id, primary_phone) WHERE deleted_at IS NULL;
CREATE INDEX leads_queue_idx ON leads (tenant_id, assigned_to, status_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_followup_idx ON leads (tenant_id, next_followup_at) WHERE deleted_at IS NULL AND next_followup_at IS NOT NULL;
CREATE INDEX leads_source_idx ON leads (tenant_id, source_id, created_at);
CREATE INDEX leads_created_idx ON leads (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_name_trgm_idx ON leads USING gin (name gin_trgm_ops);
CREATE INDEX leads_phone_trgm_idx ON leads USING gin (primary_phone gin_trgm_ops);

-- Extra phone numbers of a lead. Lookup by number must find the lead, so (tenant, phone) is indexed.
CREATE TABLE lead_phones (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  lead_id   uuid NOT NULL,
  phone     text NOT NULL CHECK (phone ~ '^[0-9]{8,15}$'),
  label     text NOT NULL DEFAULT 'alternate' CHECK (label IN ('alternate', 'parent', 'whatsapp', 'other')),
  UNIQUE (lead_id, phone),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX lead_phones_phone_idx ON lead_phones (tenant_id, phone);

-- Student details, one row per lead.
CREATE TABLE lead_profiles (
  tenant_id            uuid NOT NULL,
  lead_id              uuid PRIMARY KEY,
  alternate_email      citext CHECK (alternate_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  date_of_birth        date,
  gender               text CHECK (gender IN ('male', 'female', 'other')),
  category             text CHECK (category IN ('general', 'obc', 'sc', 'st', 'ews', 'other')),
  current_location_id  uuid REFERENCES locations (id),   -- a city, or a state when no city is known
  preferred_year       smallint CHECK (preferred_year BETWEEN 2000 AND 2100),
  preferred_level      text CHECK (preferred_level IN ('UG', 'PG', 'Diploma')),
  preferred_stream_id  uuid,
  budget_min           numeric(12, 2) CHECK (budget_min >= 0),
  budget_max           numeric(12, 2),
  loan_required        boolean,
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, preferred_stream_id) REFERENCES streams (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id),
  CHECK (budget_max IS NULL OR budget_min IS NULL OR budget_max >= budget_min)
);

-- 10th, 12th, graduation and so on. The highest level is the highest row, so nothing is stored twice.
CREATE TABLE lead_education (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL,
  lead_id     uuid NOT NULL,
  level       text NOT NULL CHECK (level IN ('10th', '12th', 'diploma', 'graduation', 'post_graduation')),
  marks_type  text CHECK (marks_type IN ('percentage', 'cgpa', 'grade')),
  marks       numeric(6, 2) CHECK (marks >= 0),
  institution text,
  board       text,
  passing_year smallint CHECK (passing_year BETWEEN 1980 AND 2100),
  UNIQUE (lead_id, level),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE lead_guardians (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL,
  relation   text NOT NULL CHECK (relation IN ('father', 'mother', 'guardian', 'other')),
  name       text,
  phone      text CHECK (phone ~ '^[0-9]{8,15}$'),
  occupation text,
  UNIQUE (lead_id, relation),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE lead_preferred_locations (
  tenant_id   uuid NOT NULL,
  lead_id     uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES locations (id),
  PRIMARY KEY (lead_id, location_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE lead_exams (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL,
  exam_name  text NOT NULL,
  marks_type text CHECK (marks_type IN ('score', 'rank', 'percentile')),
  score      numeric(10, 2),
  exam_year  smallint CHECK (exam_year BETWEEN 2000 AND 2100),
  UNIQUE (lead_id, exam_name, exam_year),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE custom_field_values (
  tenant_id uuid NOT NULL,
  def_id    uuid NOT NULL,
  lead_id   uuid NOT NULL,
  value     text NOT NULL,                       -- typed by the definition
  PRIMARY KEY (lead_id, def_id),
  FOREIGN KEY (tenant_id, def_id) REFERENCES custom_field_defs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE
);

-- Every submission that created or touched a lead: a form, an ad, an import row. A repeat enquiry
-- from the same phone adds a row here instead of a second lead. Marketing reports read this table.
CREATE TABLE lead_enquiries (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  lead_id      uuid NOT NULL,
  source_id    uuid NOT NULL,
  form_name    text,                              -- e.g. "home-popup"
  page_path    text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_term     text,
  utm_content  text,
  event_id     uuid,                              -- the raw event it came from (inbound_events)
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, source_id) REFERENCES lead_sources (tenant_id, id)
);
CREATE INDEX lead_enquiries_lead_idx ON lead_enquiries (tenant_id, lead_id, created_at DESC);
CREATE INDEX lead_enquiries_campaign_idx ON lead_enquiries (tenant_id, utm_campaign, created_at) WHERE utm_campaign IS NOT NULL;

-- Everything that happens on a lead. Partitioned by month (partitions are created in migration 008).
CREATE TABLE lead_activities (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  uuid NOT NULL,
  lead_id    uuid NOT NULL,
  user_id    uuid,                                -- NULL for the system
  type       text NOT NULL CHECK (type IN ('note', 'status_change', 'assignment', 'call', 'document', 'shortlist', 'enquiry', 'field_change', 'followup')),
  field      text,
  old_value  text,
  new_value  text,
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX lead_activities_lead_idx ON lead_activities (tenant_id, lead_id, created_at DESC);

CREATE TABLE followups (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  lead_id           uuid NOT NULL,
  user_id           uuid NOT NULL,
  due_at            timestamptz NOT NULL,
  remind_before_min integer NOT NULL DEFAULT 10 CHECK (remind_before_min >= 0),
  note              text,
  done_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX followups_open_idx ON followups (tenant_id, user_id, due_at) WHERE done_at IS NULL;
CREATE INDEX followups_lead_idx ON followups (tenant_id, lead_id);

CREATE TABLE lead_recommendations (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  lead_id        uuid NOT NULL,
  college_id     uuid NOT NULL,
  recommended_by uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, college_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, college_id) REFERENCES colleges (tenant_id, id),
  FOREIGN KEY (tenant_id, recommended_by) REFERENCES users (tenant_id, id)
);

-- A college the student shortlisted, with its progress. NI / DNP is recorded per shortlisted college.
CREATE TABLE lead_shortlists (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL,
  lead_id               uuid NOT NULL,
  college_id            uuid NOT NULL,
  shortlisted_by        uuid,
  form_status           text NOT NULL DEFAULT 'not_started' CHECK (form_status IN ('not_started', 'filled', 'submitted')),
  reconciliation_status text NOT NULL DEFAULT 'not_sent' CHECK (reconciliation_status IN ('not_sent', 'mail_sent', 'reconciled')),
  payment_status        text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'completed')),
  payment_amount        numeric(12, 2) CHECK (payment_amount >= 0),
  payment_at            timestamptz,
  ni_dnp                text CHECK (ni_dnp IN ('ni', 'dnp')),
  ni_dnp_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (lead_id, college_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, college_id) REFERENCES colleges (tenant_id, id),
  FOREIGN KEY (tenant_id, shortlisted_by) REFERENCES users (tenant_id, id),
  CHECK (payment_status = 'pending' OR (payment_amount IS NOT NULL AND payment_at IS NOT NULL))
);
CREATE INDEX lead_shortlists_payment_idx ON lead_shortlists (tenant_id, payment_status, payment_at);

-- Courses chosen under a shortlisted college. Fees are read from college_courses, never copied.
CREATE TABLE lead_shortlist_courses (
  tenant_id         uuid NOT NULL,
  shortlist_id      uuid NOT NULL,
  college_course_id uuid NOT NULL,
  PRIMARY KEY (shortlist_id, college_course_id),
  FOREIGN KEY (tenant_id, shortlist_id) REFERENCES lead_shortlists (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, college_course_id) REFERENCES college_courses (tenant_id, id)
);

CREATE TABLE lead_documents (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL,
  lead_id      uuid NOT NULL,
  shortlist_id uuid,                              -- NULL for basic documents
  doc_type     text NOT NULL CHECK (doc_type IN ('aadhaar', 'tenth', 'twelfth', 'graduation', 'photo', 'signature', 'admission', 'other')),
  file_key     text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shortlist_id) REFERENCES lead_shortlists (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX lead_documents_lead_idx ON lead_documents (tenant_id, lead_id);
