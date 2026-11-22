-- A status can mean "won": the student took admission. When a lead moves into such a status the whole team is told who
-- won it, as a small celebration. Which statuses count is the company's choice, in Lead settings; the ones that plainly
-- mean an admission start switched on.
ALTER TABLE lead_statuses ADD COLUMN is_won boolean NOT NULL DEFAULT false;

UPDATE lead_statuses SET is_won = true WHERE lower(name) IN ('won', 'admission done', 'admitted');

-- A status is either junk or won, never both.
ALTER TABLE lead_statuses ADD CONSTRAINT lead_statuses_won_not_junk CHECK (NOT (is_won AND is_junk));
