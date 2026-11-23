-- Which study modes a university is offered for (online, regular or both), set on the university itself.
-- Until each university's course list is entered, this is what lets "Study mode: Online" show only the online
-- universities. Empty means "not set": the course list decides, as before.
ALTER TABLE colleges ADD COLUMN study_modes text CHECK (study_modes IN ('online', 'regular', 'both'));
