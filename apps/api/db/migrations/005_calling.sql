-- Calling. The provider is hidden behind an adapter; these tables do not depend on which one it is.

CREATE TABLE dialer_sessions (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  status     text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'stopped', 'finished')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX dialer_sessions_user_idx ON dialer_sessions (tenant_id, user_id, started_at DESC);

CREATE TABLE dialer_session_leads (
  tenant_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  lead_id    uuid NOT NULL,
  position   integer NOT NULL CHECK (position >= 0),
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'called', 'skipped')),
  PRIMARY KEY (session_id, lead_id),
  UNIQUE (session_id, position),
  FOREIGN KEY (tenant_id, session_id) REFERENCES dialer_sessions (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id)
);

-- Every call. Partitioned by month. A unique index on a partitioned table must contain the
-- partition key, so provider_call_id is unique together with started_at; event-level idempotency
-- is enforced by inbound_events (migration 007).
CREATE TABLE calls (
  id                uuid NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL,
  lead_id           uuid,                          -- NULL when the number is unknown
  user_id           uuid,
  direction         text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  provider_call_id  text NOT NULL,
  counterparty      text NOT NULL CHECK (counterparty ~ '^[0-9]{8,15}$'),   -- the other party's number
  started_at        timestamptz NOT NULL,
  answered_at       timestamptz,
  ended_at          timestamptz,
  duration_sec      integer CHECK (duration_sec >= 0),
  outcome           text NOT NULL DEFAULT 'requested' CHECK (outcome IN ('requested', 'ringing', 'connected', 'not_picked', 'busy', 'failed', 'missed')),
  dialer_session_id uuid,
  PRIMARY KEY (id, started_at),
  UNIQUE (tenant_id, provider_call_id, started_at),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, dialer_session_id) REFERENCES dialer_sessions (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX calls_lead_idx ON calls (tenant_id, lead_id, started_at DESC);
CREATE INDEX calls_user_idx ON calls (tenant_id, user_id, started_at);
CREATE INDEX calls_missed_idx ON calls (tenant_id, started_at DESC) WHERE outcome = 'missed';

CREATE TABLE call_recordings (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL,
  call_id         uuid NOT NULL,
  call_started_at timestamptz NOT NULL,
  file_key        text NOT NULL,
  duration_sec    integer CHECK (duration_sec >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (call_id, call_started_at) REFERENCES calls (id, started_at) ON DELETE CASCADE
);
CREATE INDEX call_recordings_call_idx ON call_recordings (tenant_id, call_id);
