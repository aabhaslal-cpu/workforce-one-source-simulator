import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { OrganizationConfig, ScenarioState, Snapshot } from "./domain.js";

export type StorageKind = "memory" | "sqlite" | "postgres";

type SQLiteStatement = {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): unknown;
};

type SQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
};

type SQLiteModule = {
  DatabaseSync: new (filename: string) => SQLiteDatabase;
};

const require = createRequire(import.meta.url);

export interface SimulatorStorage {
  readonly kind: StorageKind;
  listScenarioStates(): ScenarioState[];
  getScenarioState(scenarioId: string): ScenarioState | undefined;
  saveScenarioState(state: ScenarioState): void;
  replaceScenarioStates(states: ScenarioState[]): void;
  getOrganizationConfig(): OrganizationConfig | undefined;
  saveOrganizationConfig(config: OrganizationConfig): void;
  createSnapshot(snapshot: Snapshot): void;
  getSnapshot(snapshotId: string): Snapshot | undefined;
  listSnapshots(): Snapshot[];
  close?(): void;
}

export class MemorySimulatorStorage implements SimulatorStorage {
  readonly kind = "memory" as const;
  private readonly states = new Map<string, ScenarioState>();
  private readonly snapshots = new Map<string, Snapshot>();
  private organizationConfig: OrganizationConfig | undefined;

  listScenarioStates(): ScenarioState[] {
    return [...this.states.values()].map(cloneState);
  }

  getScenarioState(scenarioId: string): ScenarioState | undefined {
    const state = this.states.get(scenarioId);
    return state ? cloneState(state) : undefined;
  }

  saveScenarioState(state: ScenarioState): void {
    this.states.set(state.scenarioId, cloneState(state));
  }

  replaceScenarioStates(states: ScenarioState[]): void {
    this.states.clear();
    for (const state of states) {
      this.saveScenarioState(state);
    }
  }

  getOrganizationConfig(): OrganizationConfig | undefined {
    return this.organizationConfig ? cloneJson(this.organizationConfig) : undefined;
  }

  saveOrganizationConfig(config: OrganizationConfig): void {
    this.organizationConfig = cloneJson(config);
  }

  createSnapshot(snapshot: Snapshot): void {
    this.snapshots.set(snapshot.snapshotId, cloneSnapshot(snapshot));
  }

  getSnapshot(snapshotId: string): Snapshot | undefined {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  listSnapshots(): Snapshot[] {
    return [...this.snapshots.values()].map(cloneSnapshot);
  }
}

export class SQLiteSimulatorStorage implements SimulatorStorage {
  readonly kind = "sqlite" as const;
  private readonly database: SQLiteDatabase;

  constructor(filename: string) {
    if (!filename.trim()) {
      throw new Error("SQLite storage requires a database path");
    }
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true });
    }
    this.database = openSQLiteDatabase(filename);
    this.database.exec(`
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
    `);
  }

  listScenarioStates(): ScenarioState[] {
    const rows = this.database.prepare("SELECT state_json FROM scenario_states ORDER BY scenario_id").all() as Array<{ state_json: string }>;
    return rows.map((row) => parseJson<ScenarioState>(row.state_json));
  }

  getScenarioState(scenarioId: string): ScenarioState | undefined {
    const row = this.database.prepare("SELECT state_json FROM scenario_states WHERE scenario_id = ?").get(scenarioId) as
      | { state_json: string }
      | undefined;
    return row ? parseJson<ScenarioState>(row.state_json) : undefined;
  }

  saveScenarioState(state: ScenarioState): void {
    this.database
      .prepare(
        `INSERT INTO scenario_states (scenario_id, state_json)
         VALUES (?, ?)
         ON CONFLICT(scenario_id) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(state.scenarioId, JSON.stringify(state));
  }

  replaceScenarioStates(states: ScenarioState[]): void {
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM scenario_states").run();
      const statement = this.database.prepare("INSERT INTO scenario_states (scenario_id, state_json) VALUES (?, ?)");
      for (const state of states) {
        statement.run(state.scenarioId, JSON.stringify(state));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getOrganizationConfig(): OrganizationConfig | undefined {
    const row = this.database.prepare("SELECT config_json FROM organization_config WHERE id = 'singleton'").get() as
      | { config_json: string }
      | undefined;
    return row ? parseJson<OrganizationConfig>(row.config_json) : undefined;
  }

  saveOrganizationConfig(config: OrganizationConfig): void {
    this.database
      .prepare(
        `INSERT INTO organization_config (id, config_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`,
      )
      .run(JSON.stringify(config));
  }

  createSnapshot(snapshot: Snapshot): void {
    this.database
      .prepare(
        `INSERT INTO snapshots (snapshot_id, created_at, snapshot_json)
         VALUES (?, ?, ?)
         ON CONFLICT(snapshot_id) DO UPDATE SET created_at = excluded.created_at, snapshot_json = excluded.snapshot_json`,
      )
      .run(snapshot.snapshotId, snapshot.createdAt, JSON.stringify(snapshot));
  }

  getSnapshot(snapshotId: string): Snapshot | undefined {
    const row = this.database.prepare("SELECT snapshot_json FROM snapshots WHERE snapshot_id = ?").get(snapshotId) as
      | { snapshot_json: string }
      | undefined;
    return row ? parseJson<Snapshot>(row.snapshot_json) : undefined;
  }

  listSnapshots(): Snapshot[] {
    const rows = this.database.prepare("SELECT snapshot_json FROM snapshots ORDER BY created_at, snapshot_id").all() as Array<{
      snapshot_json: string;
    }>;
    return rows.map((row) => parseJson<Snapshot>(row.snapshot_json));
  }

  close(): void {
    this.database.close();
  }
}

function openSQLiteDatabase(filename: string): SQLiteDatabase {
  const sqlite = require("node:sqlite") as SQLiteModule;
  return new sqlite.DatabaseSync(filename);
}

function cloneState(state: ScenarioState): ScenarioState {
  return cloneJson(state);
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return cloneJson(snapshot);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
