-- Persisted simulation clock, continuous activity orchestration, and distributed platform rate limits.

CREATE TABLE IF NOT EXISTS simulation_clock_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS continuous_orchestration_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  scope TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  window_started_at_ms BIGINT NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  PRIMARY KEY (scope, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_expires_at_ms
  ON rate_limit_buckets (expires_at_ms);
