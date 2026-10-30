-- A custom field that is no longer wanted is switched off, not deleted: the values already saved on
-- leads are kept, and the field can come back.
ALTER TABLE custom_field_defs ADD COLUMN is_active boolean NOT NULL DEFAULT true;
