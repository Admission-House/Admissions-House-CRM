-- Importing leads from a spreadsheet. The rows to process are kept in the batch itself with a pointer
-- to the next one, and each row is handled in its own transaction that also moves the pointer. A
-- crash or a restart therefore continues where it stopped, without losing or repeating a row.

CREATE TABLE lead_import_batches (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL,
  source_id      uuid NOT NULL,
  file_name      text NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'cancelled')),
  assign_mode    text NOT NULL CHECK (assign_mode IN ('auto', 'none', 'user')),
  assign_to      uuid,
  rows_in_file   integer NOT NULL CHECK (rows_in_file >= 0),     -- data rows read from the file
  invalid_count  integer NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  rows           jsonb NOT NULL DEFAULT '[]'::jsonb,            -- valid rows still to process; emptied when finished
  next_row       integer NOT NULL DEFAULT 0 CHECK (next_row >= 0),
  created_count  integer NOT NULL DEFAULT 0,                    -- new leads
  attached_count integer NOT NULL DEFAULT 0,                    -- added to a lead that already had the number
  rejected_count integer NOT NULL DEFAULT 0,                    -- refused by the duplicate policy
  failed_count   integer NOT NULL DEFAULT 0,                    -- could not be filed
  errors         jsonb NOT NULL DEFAULT '[]'::jsonb,            -- what was wrong with rows that were skipped (capped)
  assigned       jsonb NOT NULL DEFAULT '{}'::jsonb,            -- user id (or "unassigned") -> leads given
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id)  REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, assign_to)  REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK ((assign_mode = 'user') = (assign_to IS NOT NULL))
);

CREATE INDEX lead_import_batches_active_idx ON lead_import_batches (tenant_id, created_at) WHERE status IN ('queued', 'processing');
CREATE INDEX lead_import_batches_recent_idx ON lead_import_batches (tenant_id, created_at DESC);

SELECT apply_tenant_rls('lead_import_batches');
SELECT apply_updated_at('lead_import_batches');
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_import_batches TO ah_app;
