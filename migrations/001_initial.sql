-- Durable storage target for Milestone 3 verification.
-- Milestone 1 uses the storage interface in-process; this schema documents the database boundary.

CREATE TABLE IF NOT EXISTS scenario_states (
  scenario_id TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  dataset_size TEXT NOT NULL,
  started_at TEXT NOT NULL,
  current_time TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  triggered_event_ids TEXT NOT NULL,
  event_log TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  state_json TEXT NOT NULL
);
