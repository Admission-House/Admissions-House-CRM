-- Lead intake. An event must remember which source it came through, so that a retry made later,
-- outside the original request, files the lead under the right source.

-- api_keys needs the (tenant_id, id) key that the new foreign key below points to.
ALTER TABLE api_keys ADD UNIQUE (tenant_id, id);

ALTER TABLE inbound_events
  ADD COLUMN source_id       uuid,
  ADD COLUMN api_key_id      uuid,
  ADD COLUMN last_attempt_at timestamptz,
  ADD FOREIGN KEY (tenant_id, source_id)  REFERENCES lead_sources (tenant_id, id),
  ADD FOREIGN KEY (tenant_id, api_key_id) REFERENCES api_keys (tenant_id, id);

-- Round-robin looks for the person who was given a lead longest ago.
CREATE INDEX leads_assignee_recent_idx ON leads (tenant_id, assigned_to, assigned_at DESC) WHERE deleted_at IS NULL;

-- Which events to retry, in order.
DROP INDEX inbound_events_pending_idx;
CREATE INDEX inbound_events_retry_idx ON inbound_events (tenant_id, received_at) WHERE status IN ('received', 'failed');
