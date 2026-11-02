-- A switch per person for automatic lead hand-out.
--
-- When someone is not performing well, an Admin can stop new leads from being given to them
-- automatically, and move the leads they already hold to other people (POST /leads/transfer).
-- The company-wide switch (lead_policies.auto_assign) is unchanged and still turns the whole
-- automation off.
--
-- Leads can still be given to the person by hand. This only removes them from the automatic pool.

ALTER TABLE users ADD COLUMN receives_auto_leads boolean NOT NULL DEFAULT true;
