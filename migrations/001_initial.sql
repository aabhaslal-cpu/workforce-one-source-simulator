-- Durable local SQLite schema for Milestone 1.
-- This must stay aligned with SQLiteSimulatorStorage.

CREATE TABLE IF NOT EXISTS scenario_states (
  scenario_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_instance_states (
  scenario_instance_id TEXT PRIMARY KEY,
  scenario_pack_id TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS world_state (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  world_revision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_metadata (
  id TEXT PRIMARY KEY CHECK (id = 'singleton'),
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_change_ledger (
  ledger_sequence INTEGER PRIMARY KEY,
  world_revision TEXT NOT NULL,
  change_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_objects (
  source_key TEXT PRIMARY KEY,
  world_revision TEXT NOT NULL,
  object_json TEXT NOT NULL
);
