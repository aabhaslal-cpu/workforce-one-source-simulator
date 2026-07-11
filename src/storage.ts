import { mkdirSync } from "node:fs";
import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import type {
  DatasetMetadata,
  OrganizationConfig,
  ScenarioInstanceState,
  ScenarioState,
  Snapshot,
  SourceChangeLedgerEntry,
  SourceObjectProjection,
} from "./domain.js";

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
  health(): StorageHealth;
  listScenarioStates(): ScenarioState[];
  getScenarioState(scenarioId: string): ScenarioState | undefined;
  saveScenarioState(state: ScenarioState): void;
  replaceScenarioStates(states: ScenarioState[]): void;
  listScenarioInstanceStates(): ScenarioInstanceState[];
  getScenarioInstanceState(scenarioInstanceId: string): ScenarioInstanceState | undefined;
  saveScenarioInstanceState(state: ScenarioInstanceState): void;
  replaceScenarioInstanceStates(states: ScenarioInstanceState[]): void;
  getOrganizationConfig(): OrganizationConfig | undefined;
  saveOrganizationConfig(config: OrganizationConfig): void;
  getDatasetMetadata(): DatasetMetadata | undefined;
  saveDatasetMetadata(metadata: DatasetMetadata): void;
  getWorldRevision(): string | undefined;
  saveWorldRevision(worldRevision: string): void;
  listSourceChanges(): SourceChangeLedgerEntry[];
  replaceSourceChanges(changes: SourceChangeLedgerEntry[]): void;
  listSourceObjects(): SourceObjectProjection[];
  replaceSourceObjects(objects: SourceObjectProjection[]): void;
  createSnapshot(snapshot: Snapshot): void;
  getSnapshot(snapshotId: string): Snapshot | undefined;
  listSnapshots(): Snapshot[];
  replaceWorld(replacement: WorldReplacement): void;
  close?(): void;
}

export interface WorldReplacement {
  scenarioStates?: ScenarioState[];
  scenarioInstanceStates: ScenarioInstanceState[];
  organizationConfig?: OrganizationConfig;
  worldRevision: string;
  sourceChanges: SourceChangeLedgerEntry[];
  sourceObjects: SourceObjectProjection[];
  datasetMetadata: DatasetMetadata;
}

export interface StorageHealth {
  ok: boolean;
  kind: StorageKind;
  message: string;
}

export class MemorySimulatorStorage implements SimulatorStorage {
  readonly kind = "memory" as const;
  private readonly states = new Map<string, ScenarioState>();
  private readonly instanceStates = new Map<string, ScenarioInstanceState>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly sourceChanges: SourceChangeLedgerEntry[] = [];
  private readonly sourceObjects = new Map<string, SourceObjectProjection>();
  private organizationConfig: OrganizationConfig | undefined;
  private datasetMetadata: DatasetMetadata | undefined;
  private worldRevision: string | undefined;

  health(): StorageHealth {
    return { ok: true, kind: this.kind, message: "memory storage available" };
  }

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

  listScenarioInstanceStates(): ScenarioInstanceState[] {
    return [...this.instanceStates.values()].map(cloneInstanceState);
  }

  getScenarioInstanceState(scenarioInstanceId: string): ScenarioInstanceState | undefined {
    const state = this.instanceStates.get(scenarioInstanceId);
    return state ? cloneInstanceState(state) : undefined;
  }

  saveScenarioInstanceState(state: ScenarioInstanceState): void {
    this.instanceStates.set(state.scenarioInstanceId, cloneInstanceState(state));
  }

  replaceScenarioInstanceStates(states: ScenarioInstanceState[]): void {
    this.instanceStates.clear();
    for (const state of states) {
      this.saveScenarioInstanceState(state);
    }
  }

  getOrganizationConfig(): OrganizationConfig | undefined {
    return this.organizationConfig ? cloneJson(this.organizationConfig) : undefined;
  }

  saveOrganizationConfig(config: OrganizationConfig): void {
    this.organizationConfig = cloneJson(config);
  }

  getDatasetMetadata(): DatasetMetadata | undefined {
    return this.datasetMetadata ? cloneJson(this.datasetMetadata) : undefined;
  }

  saveDatasetMetadata(metadata: DatasetMetadata): void {
    this.datasetMetadata = cloneJson(metadata);
  }

  getWorldRevision(): string | undefined {
    return this.worldRevision;
  }

  saveWorldRevision(worldRevision: string): void {
    this.worldRevision = worldRevision;
  }

  listSourceChanges(): SourceChangeLedgerEntry[] {
    return this.sourceChanges.map((change) => cloneJson(change));
  }

  replaceSourceChanges(changes: SourceChangeLedgerEntry[]): void {
    this.sourceChanges.splice(0, this.sourceChanges.length, ...changes.map((change) => cloneJson(change)));
  }

  listSourceObjects(): SourceObjectProjection[] {
    return [...this.sourceObjects.values()].map((object) => cloneJson(object));
  }

  replaceSourceObjects(objects: SourceObjectProjection[]): void {
    this.sourceObjects.clear();
    for (const object of objects) {
      this.sourceObjects.set(object.sourceKey, cloneJson(object));
    }
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

  replaceWorld(replacement: WorldReplacement): void {
    const states = replacement.scenarioStates?.map(cloneState);
    const instanceStates = replacement.scenarioInstanceStates.map(cloneInstanceState);
    const organizationConfig = replacement.organizationConfig ? cloneJson(replacement.organizationConfig) : undefined;
    const sourceChanges = replacement.sourceChanges.map((change) => cloneJson(change));
    const sourceObjects = replacement.sourceObjects.map((object) => cloneJson(object));
    const datasetMetadata = cloneJson(replacement.datasetMetadata);

    if (states) {
      this.states.clear();
      for (const state of states) this.states.set(state.scenarioId, state);
    }
    this.instanceStates.clear();
    for (const state of instanceStates) this.instanceStates.set(state.scenarioInstanceId, state);
    if (organizationConfig) this.organizationConfig = organizationConfig;
    this.worldRevision = replacement.worldRevision;
    this.sourceChanges.splice(0, this.sourceChanges.length, ...sourceChanges);
    this.sourceObjects.clear();
    for (const object of sourceObjects) this.sourceObjects.set(object.sourceKey, object);
    this.datasetMetadata = datasetMetadata;
  }
}

export class SQLiteSimulatorStorage implements SimulatorStorage {
  readonly kind = "sqlite" as const;
  private readonly database: SQLiteDatabase;
  private failNextWorldReplacement = false;

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
    `);
  }

  health(): StorageHealth {
    try {
      this.database.prepare("SELECT 1").get();
      return { ok: true, kind: this.kind, message: "sqlite storage available" };
    } catch {
      return { ok: false, kind: this.kind, message: "sqlite storage unavailable" };
    }
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

  listScenarioInstanceStates(): ScenarioInstanceState[] {
    const rows = this.database.prepare("SELECT state_json FROM scenario_instance_states ORDER BY scenario_instance_id").all() as Array<{
      state_json: string;
    }>;
    return rows.map((row) => parseJson<ScenarioInstanceState>(row.state_json));
  }

  getScenarioInstanceState(scenarioInstanceId: string): ScenarioInstanceState | undefined {
    const row = this.database.prepare("SELECT state_json FROM scenario_instance_states WHERE scenario_instance_id = ?").get(scenarioInstanceId) as
      | { state_json: string }
      | undefined;
    return row ? parseJson<ScenarioInstanceState>(row.state_json) : undefined;
  }

  saveScenarioInstanceState(state: ScenarioInstanceState): void {
    this.database
      .prepare(
        `INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json)
         VALUES (?, ?, ?)
         ON CONFLICT(scenario_instance_id) DO UPDATE SET scenario_pack_id = excluded.scenario_pack_id, state_json = excluded.state_json`,
      )
      .run(state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state));
  }

  replaceScenarioInstanceStates(states: ScenarioInstanceState[]): void {
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM scenario_instance_states").run();
      const statement = this.database.prepare(
        "INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES (?, ?, ?)",
      );
      for (const state of states) {
        statement.run(state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state));
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

  getDatasetMetadata(): DatasetMetadata | undefined {
    const row = this.database.prepare("SELECT metadata_json FROM dataset_metadata WHERE id = 'singleton'").get() as
      | { metadata_json: string }
      | undefined;
    return row ? parseJson<DatasetMetadata>(row.metadata_json) : undefined;
  }

  saveDatasetMetadata(metadata: DatasetMetadata): void {
    this.database
      .prepare(
        `INSERT INTO dataset_metadata (id, metadata_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`,
      )
      .run(JSON.stringify(metadata));
  }

  getWorldRevision(): string | undefined {
    const row = this.database.prepare("SELECT world_revision FROM world_state WHERE id = 'singleton'").get() as
      | { world_revision: string }
      | undefined;
    return row?.world_revision;
  }

  saveWorldRevision(worldRevision: string): void {
    this.database
      .prepare(
        `INSERT INTO world_state (id, world_revision)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET world_revision = excluded.world_revision`,
      )
      .run(worldRevision);
  }

  listSourceChanges(): SourceChangeLedgerEntry[] {
    const rows = this.database.prepare("SELECT change_json FROM source_change_ledger ORDER BY ledger_sequence").all() as Array<{
      change_json: string;
    }>;
    return rows.map((row) => parseJson<SourceChangeLedgerEntry>(row.change_json));
  }

  replaceSourceChanges(changes: SourceChangeLedgerEntry[]): void {
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM source_change_ledger").run();
      const statement = this.database.prepare(
        "INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES (?, ?, ?)",
      );
      for (const change of changes) {
        statement.run(change.ledgerSequence, change.worldRevision, JSON.stringify(change));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listSourceObjects(): SourceObjectProjection[] {
    const rows = this.database.prepare("SELECT object_json FROM source_objects ORDER BY source_key").all() as Array<{ object_json: string }>;
    return rows.map((row) => parseJson<SourceObjectProjection>(row.object_json));
  }

  replaceSourceObjects(objects: SourceObjectProjection[]): void {
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM source_objects").run();
      const statement = this.database.prepare("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES (?, ?, ?)");
      for (const object of objects) {
        statement.run(object.sourceKey, object.worldRevision, JSON.stringify(object));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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

  replaceWorld(replacement: WorldReplacement): void {
    this.database.exec("BEGIN");
    try {
      if (replacement.scenarioStates) {
        this.database.prepare("DELETE FROM scenario_states").run();
        const statement = this.database.prepare("INSERT INTO scenario_states (scenario_id, state_json) VALUES (?, ?)");
        for (const state of replacement.scenarioStates) {
          statement.run(state.scenarioId, JSON.stringify(state));
        }
      }

      this.database.prepare("DELETE FROM scenario_instance_states").run();
      const instanceStatement = this.database.prepare(
        "INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES (?, ?, ?)",
      );
      for (const state of replacement.scenarioInstanceStates) {
        instanceStatement.run(state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state));
      }

      if (this.failNextWorldReplacement) {
        this.failNextWorldReplacement = false;
        throw new Error("Injected world replacement failure");
      }

      if (replacement.organizationConfig) {
        this.database
          .prepare(
            `INSERT INTO organization_config (id, config_json)
             VALUES ('singleton', ?)
             ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`,
          )
          .run(JSON.stringify(replacement.organizationConfig));
      }

      this.database
        .prepare(
          `INSERT INTO world_state (id, world_revision)
           VALUES ('singleton', ?)
           ON CONFLICT(id) DO UPDATE SET world_revision = excluded.world_revision`,
        )
        .run(replacement.worldRevision);

      this.database.prepare("DELETE FROM source_change_ledger").run();
      const changeStatement = this.database.prepare(
        "INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES (?, ?, ?)",
      );
      for (const change of replacement.sourceChanges) {
        changeStatement.run(change.ledgerSequence, change.worldRevision, JSON.stringify(change));
      }

      this.database.prepare("DELETE FROM source_objects").run();
      const objectStatement = this.database.prepare("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES (?, ?, ?)");
      for (const object of replacement.sourceObjects) {
        objectStatement.run(object.sourceKey, object.worldRevision, JSON.stringify(object));
      }

      this.database
        .prepare(
          `INSERT INTO dataset_metadata (id, metadata_json)
           VALUES ('singleton', ?)
           ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`,
        )
        .run(JSON.stringify(replacement.datasetMetadata));

      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  injectWorldReplacementFailureForTesting(): void {
    this.failNextWorldReplacement = true;
  }

  close(): void {
    this.database.close();
  }
}

export interface PostgresSimulatorStorageOptions {
  connectionString: string;
  resetForTesting?: boolean;
}

export class PostgresSimulatorStorage implements SimulatorStorage {
  readonly kind = "postgres" as const;
  private static nextInstanceId = 0;
  private readonly worker: Worker;
  private readonly instanceId: number;
  private closed = false;
  private requestCounter = 0;

  constructor(options: string | PostgresSimulatorStorageOptions) {
    const connectionString = typeof options === "string" ? options : options.connectionString;
    const resetForTesting = typeof options === "string" ? false : options.resetForTesting === true;
    if (!connectionString.trim()) {
      throw new Error("Postgres storage requires DATABASE_URL");
    }
    PostgresSimulatorStorage.nextInstanceId += 1;
    this.instanceId = PostgresSimulatorStorage.nextInstanceId;
    this.worker = new Worker(POSTGRES_WORKER_SOURCE, {
      eval: true,
      workerData: { connectionString },
    });
    this.call("migrate", { resetForTesting });
  }

  health(): StorageHealth {
    return this.call<StorageHealth>("health", {});
  }

  listScenarioStates(): ScenarioState[] {
    return this.call<ScenarioState[]>("listScenarioStates", {});
  }

  getScenarioState(scenarioId: string): ScenarioState | undefined {
    return this.call<ScenarioState | undefined>("getScenarioState", { scenarioId });
  }

  saveScenarioState(state: ScenarioState): void {
    this.call<void>("saveScenarioState", { state });
  }

  replaceScenarioStates(states: ScenarioState[]): void {
    this.call<void>("replaceScenarioStates", { states });
  }

  listScenarioInstanceStates(): ScenarioInstanceState[] {
    return this.call<ScenarioInstanceState[]>("listScenarioInstanceStates", {});
  }

  getScenarioInstanceState(scenarioInstanceId: string): ScenarioInstanceState | undefined {
    return this.call<ScenarioInstanceState | undefined>("getScenarioInstanceState", { scenarioInstanceId });
  }

  saveScenarioInstanceState(state: ScenarioInstanceState): void {
    this.call<void>("saveScenarioInstanceState", { state });
  }

  replaceScenarioInstanceStates(states: ScenarioInstanceState[]): void {
    this.call<void>("replaceScenarioInstanceStates", { states });
  }

  getOrganizationConfig(): OrganizationConfig | undefined {
    return this.call<OrganizationConfig | undefined>("getOrganizationConfig", {});
  }

  saveOrganizationConfig(config: OrganizationConfig): void {
    this.call<void>("saveOrganizationConfig", { config });
  }

  getDatasetMetadata(): DatasetMetadata | undefined {
    return this.call<DatasetMetadata | undefined>("getDatasetMetadata", {});
  }

  saveDatasetMetadata(metadata: DatasetMetadata): void {
    this.call<void>("saveDatasetMetadata", { metadata });
  }

  getWorldRevision(): string | undefined {
    return this.call<string | undefined>("getWorldRevision", {});
  }

  saveWorldRevision(worldRevision: string): void {
    this.call<void>("saveWorldRevision", { worldRevision });
  }

  listSourceChanges(): SourceChangeLedgerEntry[] {
    return this.call<SourceChangeLedgerEntry[]>("listSourceChanges", {});
  }

  replaceSourceChanges(changes: SourceChangeLedgerEntry[]): void {
    this.call<void>("replaceSourceChanges", { changes });
  }

  listSourceObjects(): SourceObjectProjection[] {
    return this.call<SourceObjectProjection[]>("listSourceObjects", {});
  }

  replaceSourceObjects(objects: SourceObjectProjection[]): void {
    this.call<void>("replaceSourceObjects", { objects });
  }

  createSnapshot(snapshot: Snapshot): void {
    this.call<void>("createSnapshot", { snapshot });
  }

  getSnapshot(snapshotId: string): Snapshot | undefined {
    return this.call<Snapshot | undefined>("getSnapshot", { snapshotId });
  }

  listSnapshots(): Snapshot[] {
    return this.call<Snapshot[]>("listSnapshots", {});
  }

  replaceWorld(replacement: WorldReplacement): void {
    this.call<void>("replaceWorld", { replacement });
  }

  injectWorldReplacementFailureForTesting(): void {
    this.call<void>("injectWorldReplacementFailureForTesting", {});
  }

  close(): void {
    if (this.closed) return;
    try {
      this.call<void>("close", {});
    } finally {
      this.closed = true;
      void this.worker.terminate();
    }
  }

  private call<T>(task: string, payload: Record<string, unknown>): T {
    if (this.closed) throw new Error("Postgres storage is closed");
    const signal = new SharedArrayBuffer(4);
    const signalView = new Int32Array(signal);
    this.requestCounter += 1;
    const resultFile = join(tmpdir(), `source-simulator-pg-${process.pid}-${this.instanceId}-${this.requestCounter}.json`);
    this.worker.postMessage({ task, payload, resultFile, signal });
    const waitResult = Atomics.wait(signalView, 0, 0, 120_000);
    if (waitResult === "timed-out") {
      throw new Error(`Postgres storage operation timed out: ${task}`);
    }
    try {
      const raw = readFileSync(resultFile, "utf8");
      const result = JSON.parse(raw) as { ok: true; value: T } | { ok: false; error: string };
      if (!result.ok) throw new Error(result.error);
      return result.value;
    } finally {
      try {
        unlinkSync(resultFile);
      } catch {
        // best effort cleanup
      }
    }
  }
}

function openSQLiteDatabase(filename: string): SQLiteDatabase {
  const sqlite = require("node:sqlite") as SQLiteModule;
  return new sqlite.DatabaseSync(filename);
}

function cloneState(state: ScenarioState): ScenarioState {
  return cloneJson(state);
}

function cloneInstanceState(state: ScenarioInstanceState): ScenarioInstanceState {
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

const POSTGRES_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeFileSync } = require("node:fs");
const pg = require("pg");

const { Pool } = pg;
const pool = new Pool({ connectionString: workerData.connectionString });
let failNextWorldReplacement = false;

const tables = [
  "scenario_states",
  "scenario_instance_states",
  "organization_config",
  "snapshots",
  "world_state",
  "dataset_metadata",
  "source_change_ledger",
  "source_objects"
];

function json(value) {
  return JSON.stringify(value);
}

function parse(value) {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value);
}

async function migrate(resetForTesting) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (resetForTesting) {
      for (const table of [...tables].reverse()) await client.query("DROP TABLE IF EXISTS " + table);
    }
    await client.query("CREATE TABLE IF NOT EXISTS scenario_states (scenario_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS scenario_instance_states (scenario_instance_id TEXT PRIMARY KEY, scenario_pack_id TEXT NOT NULL, state_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS organization_config (id TEXT PRIMARY KEY CHECK (id = 'singleton'), config_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS snapshots (snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS world_state (id TEXT PRIMARY KEY CHECK (id = 'singleton'), world_revision TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS dataset_metadata (id TEXT PRIMARY KEY CHECK (id = 'singleton'), metadata_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS source_change_ledger (ledger_sequence INTEGER PRIMARY KEY, world_revision TEXT NOT NULL, change_json TEXT NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS source_objects (source_key TEXT PRIMARY KEY, world_revision TEXT NOT NULL, object_json TEXT NOT NULL)");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function handle(task, payload) {
  switch (task) {
    case "migrate":
      await migrate(payload.resetForTesting === true);
      return undefined;
    case "health":
      await pool.query("SELECT 1");
      return { ok: true, kind: "postgres", message: "postgres storage available" };
    case "listScenarioStates":
      return (await pool.query("SELECT state_json FROM scenario_states ORDER BY scenario_id")).rows.map((row) => parse(row.state_json));
    case "getScenarioState": {
      const row = (await pool.query("SELECT state_json FROM scenario_states WHERE scenario_id = $1", [payload.scenarioId])).rows[0];
      return row ? parse(row.state_json) : undefined;
    }
    case "saveScenarioState":
      await pool.query("INSERT INTO scenario_states (scenario_id, state_json) VALUES ($1, $2) ON CONFLICT (scenario_id) DO UPDATE SET state_json = EXCLUDED.state_json", [payload.state.scenarioId, json(payload.state)]);
      return undefined;
    case "replaceScenarioStates":
      await transaction(async (client) => {
        await client.query("DELETE FROM scenario_states");
        for (const state of payload.states) await client.query("INSERT INTO scenario_states (scenario_id, state_json) VALUES ($1, $2)", [state.scenarioId, json(state)]);
      });
      return undefined;
    case "listScenarioInstanceStates":
      return (await pool.query("SELECT state_json FROM scenario_instance_states ORDER BY scenario_instance_id")).rows.map((row) => parse(row.state_json));
    case "getScenarioInstanceState": {
      const row = (await pool.query("SELECT state_json FROM scenario_instance_states WHERE scenario_instance_id = $1", [payload.scenarioInstanceId])).rows[0];
      return row ? parse(row.state_json) : undefined;
    }
    case "saveScenarioInstanceState":
      await pool.query("INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES ($1, $2, $3) ON CONFLICT (scenario_instance_id) DO UPDATE SET scenario_pack_id = EXCLUDED.scenario_pack_id, state_json = EXCLUDED.state_json", [payload.state.scenarioInstanceId, payload.state.scenarioPackId, json(payload.state)]);
      return undefined;
    case "replaceScenarioInstanceStates":
      await transaction(async (client) => {
        await client.query("DELETE FROM scenario_instance_states");
        for (const state of payload.states) await client.query("INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES ($1, $2, $3)", [state.scenarioInstanceId, state.scenarioPackId, json(state)]);
      });
      return undefined;
    case "getOrganizationConfig": {
      const row = (await pool.query("SELECT config_json FROM organization_config WHERE id = 'singleton'")).rows[0];
      return row ? parse(row.config_json) : undefined;
    }
    case "saveOrganizationConfig":
      await pool.query("INSERT INTO organization_config (id, config_json) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json", [json(payload.config)]);
      return undefined;
    case "getDatasetMetadata": {
      const row = (await pool.query("SELECT metadata_json FROM dataset_metadata WHERE id = 'singleton'")).rows[0];
      return row ? parse(row.metadata_json) : undefined;
    }
    case "saveDatasetMetadata":
      await pool.query("INSERT INTO dataset_metadata (id, metadata_json) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json", [json(payload.metadata)]);
      return undefined;
    case "getWorldRevision": {
      const row = (await pool.query("SELECT world_revision FROM world_state WHERE id = 'singleton'")).rows[0];
      return row?.world_revision;
    }
    case "saveWorldRevision":
      await pool.query("INSERT INTO world_state (id, world_revision) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET world_revision = EXCLUDED.world_revision", [payload.worldRevision]);
      return undefined;
    case "listSourceChanges":
      return (await pool.query("SELECT change_json FROM source_change_ledger ORDER BY ledger_sequence")).rows.map((row) => parse(row.change_json));
    case "replaceSourceChanges":
      await transaction(async (client) => {
        await client.query("DELETE FROM source_change_ledger");
        for (const change of payload.changes) await client.query("INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES ($1, $2, $3)", [change.ledgerSequence, change.worldRevision, json(change)]);
      });
      return undefined;
    case "listSourceObjects":
      return (await pool.query("SELECT object_json FROM source_objects ORDER BY source_key")).rows.map((row) => parse(row.object_json));
    case "replaceSourceObjects":
      await transaction(async (client) => {
        await client.query("DELETE FROM source_objects");
        for (const object of payload.objects) await client.query("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES ($1, $2, $3)", [object.sourceKey, object.worldRevision, json(object)]);
      });
      return undefined;
    case "createSnapshot":
      await pool.query("INSERT INTO snapshots (snapshot_id, created_at, snapshot_json) VALUES ($1, $2, $3) ON CONFLICT (snapshot_id) DO UPDATE SET created_at = EXCLUDED.created_at, snapshot_json = EXCLUDED.snapshot_json", [payload.snapshot.snapshotId, payload.snapshot.createdAt, json(payload.snapshot)]);
      return undefined;
    case "getSnapshot": {
      const row = (await pool.query("SELECT snapshot_json FROM snapshots WHERE snapshot_id = $1", [payload.snapshotId])).rows[0];
      return row ? parse(row.snapshot_json) : undefined;
    }
    case "listSnapshots":
      return (await pool.query("SELECT snapshot_json FROM snapshots ORDER BY created_at, snapshot_id")).rows.map((row) => parse(row.snapshot_json));
    case "replaceWorld":
      await transaction(async (client) => {
        if (failNextWorldReplacement) {
          failNextWorldReplacement = false;
          await client.query("DELETE FROM source_change_ledger");
          throw new Error("Injected world replacement failure");
        }
        if (payload.replacement.scenarioStates) {
          await client.query("DELETE FROM scenario_states");
          for (const state of payload.replacement.scenarioStates) await client.query("INSERT INTO scenario_states (scenario_id, state_json) VALUES ($1, $2)", [state.scenarioId, json(state)]);
        }
        await client.query("DELETE FROM scenario_instance_states");
        for (const state of payload.replacement.scenarioInstanceStates) await client.query("INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES ($1, $2, $3)", [state.scenarioInstanceId, state.scenarioPackId, json(state)]);
        if (payload.replacement.organizationConfig) await client.query("INSERT INTO organization_config (id, config_json) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json", [json(payload.replacement.organizationConfig)]);
        await client.query("INSERT INTO world_state (id, world_revision) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET world_revision = EXCLUDED.world_revision", [payload.replacement.worldRevision]);
        await client.query("DELETE FROM source_change_ledger");
        for (const change of payload.replacement.sourceChanges) await client.query("INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES ($1, $2, $3)", [change.ledgerSequence, change.worldRevision, json(change)]);
        await client.query("DELETE FROM source_objects");
        for (const object of payload.replacement.sourceObjects) await client.query("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES ($1, $2, $3)", [object.sourceKey, object.worldRevision, json(object)]);
        await client.query("INSERT INTO dataset_metadata (id, metadata_json) VALUES ('singleton', $1) ON CONFLICT (id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json", [json(payload.replacement.datasetMetadata)]);
      });
      return undefined;
    case "injectWorldReplacementFailureForTesting":
      failNextWorldReplacement = true;
      return undefined;
    case "close":
      await pool.end();
      return undefined;
    default:
      throw new Error("Unknown Postgres storage operation: " + task);
  }
}

parentPort.on("message", async (message) => {
  try {
    const value = await handle(message.task, message.payload ?? {});
    writeFileSync(message.resultFile, JSON.stringify({ ok: true, value }));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Postgres storage operation failed";
    writeFileSync(message.resultFile, JSON.stringify({ ok: false, error: messageText }));
  } finally {
    const signalView = new Int32Array(message.signal);
    Atomics.store(signalView, 0, 1);
    Atomics.notify(signalView, 0);
  }
});
`;
