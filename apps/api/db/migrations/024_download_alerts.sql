-- Which website forms mean "a visitor asked to download something" (a brochure, a guide). When a lead
-- arrives through a form whose name contains one of these words, every Super Admin is told.
ALTER TABLE lead_policies
  ADD COLUMN download_forms text[] NOT NULL DEFAULT ARRAY['brochure', 'download'];
