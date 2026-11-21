-- 1. A status can be marked as one that means a junk lead (a fake enquiry, a wrong lead, a wrong number), so the lead list can show or hide
--    them together. Which statuses count is the company's choice, in Lead settings.
ALTER TABLE lead_statuses ADD COLUMN is_junk boolean NOT NULL DEFAULT false;

-- 2. A student sent to a partner college is "shortlisted" with it. If the college says the student did not pick up, a counsellor marks it
--    as DNP, and the lead shows that right next to the college.
ALTER TABLE lead_partner_submissions
  ADD COLUMN dnp_at     timestamptz,
  ADD COLUMN dnp_reason text,
  ADD COLUMN dnp_by     uuid,
  ADD FOREIGN KEY (tenant_id, dnp_by) REFERENCES users (tenant_id, id);
GRANT UPDATE (dnp_at, dnp_reason, dnp_by) ON lead_partner_submissions TO ah_app;
