-- Uploaded documents: what the person called the file, and a fingerprint of its content.
ALTER TABLE lead_documents
  ADD COLUMN original_name text NOT NULL DEFAULT 'document',
  ADD COLUMN sha256        text;

-- The documents of a lead, grouped by kind.
CREATE INDEX lead_documents_type_idx ON lead_documents (tenant_id, lead_id, doc_type);
