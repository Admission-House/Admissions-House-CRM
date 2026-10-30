-- What came of an event (a lead was created, attached to an existing one, or refused), so that the
-- same delivery arriving again gets the same answer instead of a second lead.
ALTER TABLE inbound_events ADD COLUMN result jsonb;
