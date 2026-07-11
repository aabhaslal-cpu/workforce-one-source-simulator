-- Durable local SQLite schema for Milestone 1.
-- This must stay aligned with SQLiteSimulatorStorage.

CREATE TABLE IF NOT EXISTS scenario_states (
  scenario_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_config (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  config_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
