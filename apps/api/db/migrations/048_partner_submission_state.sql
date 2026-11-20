-- A submission is recorded as "sending" before the college is called and finished afterwards. That is what stops a double click, or two
-- counsellors at once, from sending the same student twice: the second one finds the first still in flight.
ALTER TABLE lead_partner_submissions ADD COLUMN state text NOT NULL DEFAULT 'sent' CHECK (state IN ('sending', 'sent', 'failed'));
GRANT UPDATE (state, ok, http_status, response) ON lead_partner_submissions TO ah_app;
