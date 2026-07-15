import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import pg, { type Pool as PgPool, type PoolClient, type QueryResult } from "pg";
import type {
  ContinuousOrchestrationState,
  DatasetMetadata,
  OrganizationConfig,
  ScenarioInstanceState,
  ScenarioState,
  SimulationClockState,
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
const { Pool } = pg;
const POSTGRES_WORLD_LOCK_ID = "71452711301011";
const POSTGRES_MIGRATIONS = [
  { version: "001_initial", path: "../migrations/postgres_001_initial.sql" },
  { version: "002_clock_runtime", path: "../migrations/postgres_002_clock_runtime.sql" },
] as const;

export interface SimulatorStorage {
  readonly kind: StorageKind;
  health(): Promise<StorageHealth>;
  listScenarioStates(): Promise<ScenarioState[]>;
  getScenarioState(scenarioId: string): Promise<ScenarioState | undefined>;
  saveScenarioState(state: ScenarioState): Promise<void>;
  replaceScenarioStates(states: ScenarioState[]): Promise<void>;
  listScenarioInstanceStates(): Promise<ScenarioInstanceState[]>;
  getScenarioInstanceState(scenarioInstanceId: string): Promise<ScenarioInstanceState | undefined>;
  saveScenarioInstanceState(state: ScenarioInstanceState): Promise<void>;
  replaceScenarioInstanceStates(states: ScenarioInstanceState[]): Promise<void>;
  getOrganizationConfig(): Promise<OrganizationConfig | undefined>;
  saveOrganizationConfig(config: OrganizationConfig): Promise<void>;
  getDatasetMetadata(): Promise<DatasetMetadata | undefined>;
  saveDatasetMetadata(metadata: DatasetMetadata): Promise<void>;
  getClockState(): Promise<SimulationClockState | undefined>;
  saveClockState(state: SimulationClockState): Promise<void>;
  getOrchestrationState(): Promise<ContinuousOrchestrationState | undefined>;
  saveOrchestrationState(state: ContinuousOrchestrationState): Promise<void>;
  getWorldRevision(): Promise<string | undefined>;
  saveWorldRevision(worldRevision: string): Promise<void>;
  listSourceChanges(): Promise<SourceChangeLedgerEntry[]>;
  replaceSourceChanges(changes: SourceChangeLedgerEntry[]): Promise<void>;
  listSourceObjects(): Promise<SourceObjectProjection[]>;
  replaceSourceObjects(objects: SourceObjectProjection[]): Promise<void>;
  createSnapshot(snapshot: Snapshot): Promise<void>;
  getSnapshot(snapshotId: string): Promise<Snapshot | undefined>;
  listSnapshots(): Promise<Snapshot[]>;
  replaceWorld(replacement: WorldReplacement, options?: WorldMutationOptions): Promise<void>;
  mutateWorld<T>(mutation: WorldMutation<T>, options?: WorldMutationOptions): Promise<T>;
  checkRateLimit?(input: StorageRateLimitInput): Promise<StorageRateLimitDecision>;
  close?(): Promise<void>;
}

export interface WorldReplacement {
  scenarioStates?: ScenarioState[];
  scenarioInstanceStates: ScenarioInstanceState[];
  organizationConfig?: OrganizationConfig;
  worldRevision: string;
  sourceChanges: SourceChangeLedgerEntry[];
  sourceObjects: SourceObjectProjection[];
  datasetMetadata: DatasetMetadata;
  clockState?: SimulationClockState;
  orchestrationState?: ContinuousOrchestrationState;
}

export interface WorldSnapshot {
  scenarioStates: ScenarioState[];
  scenarioInstanceStates: ScenarioInstanceState[];
  organizationConfig?: OrganizationConfig;
  worldRevision?: string;
  sourceChanges: SourceChangeLedgerEntry[];
  sourceObjects: SourceObjectProjection[];
  datasetMetadata?: DatasetMetadata;
  clockState?: SimulationClockState;
  orchestrationState?: ContinuousOrchestrationState;
}

export interface WorldMutationResult<T> {
  replacement: WorldReplacement;
  result: T;
}

export type WorldMutation<T> = (snapshot: WorldSnapshot) => WorldMutationResult<T> | Promise<WorldMutationResult<T>>;

export interface WorldMutationOptions {
  expectedWorldRevision?: string;
}

export interface StorageHealth {
  ok: boolean;
  kind: StorageKind;
  message: string;
}

export interface StorageRateLimitInput {
  scope: "admin" | "connection" | "cron";
  identityKey: string;
  limit: number;
  windowMs: number;
  nowMs: number;
}

export interface StorageRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class StorageError extends Error {
  constructor(message = "Storage operation failed") {
    super(message);
  }
}

export class WorldConflictError extends Error {
  constructor(message = "Simulator world changed before the operation could commit") {
    super(message);
  }
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
  private clockState: SimulationClockState | undefined;
  private orchestrationState: ContinuousOrchestrationState | undefined;
  private worldRevision: string | undefined;
  private mutationQueue = Promise.resolve();

  async health(): Promise<StorageHealth> {
    return { ok: true, kind: this.kind, message: "memory storage available" };
  }

  async listScenarioStates(): Promise<ScenarioState[]> {
    return [...this.states.values()].map(cloneState);
  }

  async getScenarioState(scenarioId: string): Promise<ScenarioState | undefined> {
    const state = this.states.get(scenarioId);
    return state ? cloneState(state) : undefined;
  }

  async saveScenarioState(state: ScenarioState): Promise<void> {
    this.states.set(state.scenarioId, cloneState(state));
  }

  async replaceScenarioStates(states: ScenarioState[]): Promise<void> {
    this.states.clear();
    for (const state of states) this.states.set(state.scenarioId, cloneState(state));
  }

  async listScenarioInstanceStates(): Promise<ScenarioInstanceState[]> {
    return [...this.instanceStates.values()].map(cloneInstanceState);
  }

  async getScenarioInstanceState(scenarioInstanceId: string): Promise<ScenarioInstanceState | undefined> {
    const state = this.instanceStates.get(scenarioInstanceId);
    return state ? cloneInstanceState(state) : undefined;
  }

  async saveScenarioInstanceState(state: ScenarioInstanceState): Promise<void> {
    this.instanceStates.set(state.scenarioInstanceId, cloneInstanceState(state));
  }

  async replaceScenarioInstanceStates(states: ScenarioInstanceState[]): Promise<void> {
    this.instanceStates.clear();
    for (const state of states) this.instanceStates.set(state.scenarioInstanceId, cloneInstanceState(state));
  }

  async getOrganizationConfig(): Promise<OrganizationConfig | undefined> {
    return this.organizationConfig ? cloneJson(this.organizationConfig) : undefined;
  }

  async saveOrganizationConfig(config: OrganizationConfig): Promise<void> {
    this.organizationConfig = cloneJson(config);
  }

  async getDatasetMetadata(): Promise<DatasetMetadata | undefined> {
    return this.datasetMetadata ? cloneJson(this.datasetMetadata) : undefined;
  }

  async saveDatasetMetadata(metadata: DatasetMetadata): Promise<void> {
    this.datasetMetadata = cloneJson(metadata);
  }

  async getClockState(): Promise<SimulationClockState | undefined> {
    return this.clockState ? cloneJson(this.clockState) : undefined;
  }

  async saveClockState(state: SimulationClockState): Promise<void> {
    this.clockState = cloneJson(state);
  }

  async getOrchestrationState(): Promise<ContinuousOrchestrationState | undefined> {
    return this.orchestrationState ? cloneJson(this.orchestrationState) : undefined;
  }

  async saveOrchestrationState(state: ContinuousOrchestrationState): Promise<void> {
    this.orchestrationState = cloneJson(state);
  }

  async getWorldRevision(): Promise<string | undefined> {
    return this.worldRevision;
  }

  async saveWorldRevision(worldRevision: string): Promise<void> {
    this.worldRevision = worldRevision;
  }

  async listSourceChanges(): Promise<SourceChangeLedgerEntry[]> {
    return this.sourceChanges.map((change) => cloneJson(change));
  }

  async replaceSourceChanges(changes: SourceChangeLedgerEntry[]): Promise<void> {
    this.sourceChanges.splice(0, this.sourceChanges.length, ...changes.map((change) => cloneJson(change)));
  }

  async listSourceObjects(): Promise<SourceObjectProjection[]> {
    return [...this.sourceObjects.values()].map((object) => cloneJson(object));
  }

  async replaceSourceObjects(objects: SourceObjectProjection[]): Promise<void> {
    this.sourceObjects.clear();
    for (const object of objects) this.sourceObjects.set(object.sourceKey, cloneJson(object));
  }

  async createSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshots.set(snapshot.snapshotId, cloneSnapshot(snapshot));
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | undefined> {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    return [...this.snapshots.values()].map(cloneSnapshot);
  }

  async replaceWorld(replacement: WorldReplacement, options: WorldMutationOptions = {}): Promise<void> {
    await this.mutateWorld(() => ({ replacement, result: undefined }), options);
  }

  async mutateWorld<T>(mutation: WorldMutation<T>, options: WorldMutationOptions = {}): Promise<T> {
    return this.withMutationLock(async () => {
      const snapshot = this.worldSnapshot();
      if (options.expectedWorldRevision && snapshot.worldRevision !== options.expectedWorldRevision) throw new WorldConflictError();
      const output = await mutation(cloneJson(snapshot));
      this.applyWorldReplacement(output.replacement);
      return output.result;
    });
  }

  private async withMutationLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  private worldSnapshot(): WorldSnapshot {
    return {
      scenarioStates: [...this.states.values()].map(cloneState),
      scenarioInstanceStates: [...this.instanceStates.values()].map(cloneInstanceState),
      ...(this.organizationConfig ? { organizationConfig: cloneJson(this.organizationConfig) } : {}),
      ...(this.worldRevision ? { worldRevision: this.worldRevision } : {}),
      sourceChanges: this.sourceChanges.map((change) => cloneJson(change)),
      sourceObjects: [...this.sourceObjects.values()].map((object) => cloneJson(object)),
      ...(this.datasetMetadata ? { datasetMetadata: cloneJson(this.datasetMetadata) } : {}),
      ...(this.clockState ? { clockState: cloneJson(this.clockState) } : {}),
      ...(this.orchestrationState ? { orchestrationState: cloneJson(this.orchestrationState) } : {}),
    };
  }

  private applyWorldReplacement(replacement: WorldReplacement): void {
    if (replacement.scenarioStates) {
      this.states.clear();
      for (const state of replacement.scenarioStates) this.states.set(state.scenarioId, cloneState(state));
    }
    this.instanceStates.clear();
    for (const state of replacement.scenarioInstanceStates) this.instanceStates.set(state.scenarioInstanceId, cloneInstanceState(state));
    if (replacement.organizationConfig) this.organizationConfig = cloneJson(replacement.organizationConfig);
    this.worldRevision = replacement.worldRevision;
    this.sourceChanges.splice(0, this.sourceChanges.length, ...replacement.sourceChanges.map((change) => cloneJson(change)));
    this.sourceObjects.clear();
    for (const object of replacement.sourceObjects) this.sourceObjects.set(object.sourceKey, cloneJson(object));
    this.datasetMetadata = cloneJson(replacement.datasetMetadata);
    if (replacement.clockState) this.clockState = cloneJson(replacement.clockState);
    if (replacement.orchestrationState) this.orchestrationState = cloneJson(replacement.orchestrationState);
  }
}

export class SQLiteSimulatorStorage implements SimulatorStorage {
  readonly kind = "sqlite" as const;
  private readonly database: SQLiteDatabase;
  private failNextWorldReplacement = false;

  constructor(filename: string) {
    if (!filename.trim()) throw new Error("SQLite storage requires a database path");
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.database = openSQLiteDatabase(filename);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS scenario_states (scenario_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scenario_instance_states (scenario_instance_id TEXT PRIMARY KEY, scenario_pack_id TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organization_config (id TEXT PRIMARY KEY CHECK (id = 'singleton'), config_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_state (id TEXT PRIMARY KEY CHECK (id = 'singleton'), world_revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_metadata (id TEXT PRIMARY KEY CHECK (id = 'singleton'), metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS simulation_clock_state (id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuous_orchestration_state (id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_change_ledger (ledger_sequence INTEGER PRIMARY KEY, world_revision TEXT NOT NULL, change_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_objects (source_key TEXT PRIMARY KEY, world_revision TEXT NOT NULL, object_json TEXT NOT NULL);
    `);
  }

  async health(): Promise<StorageHealth> {
    try {
      this.database.prepare("SELECT 1").get();
      return { ok: true, kind: this.kind, message: "sqlite storage available" };
    } catch {
      return { ok: false, kind: this.kind, message: "sqlite storage unavailable" };
    }
  }

  async listScenarioStates(): Promise<ScenarioState[]> {
    return this.readScenarioStates();
  }

  async getScenarioState(scenarioId: string): Promise<ScenarioState | undefined> {
    const row = this.database.prepare("SELECT state_json FROM scenario_states WHERE scenario_id = ?").get(scenarioId) as
      | { state_json: string }
      | undefined;
    return row ? parseJson<ScenarioState>(row.state_json) : undefined;
  }

  async saveScenarioState(state: ScenarioState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO scenario_states (scenario_id, state_json)
         VALUES (?, ?)
         ON CONFLICT(scenario_id) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(state.scenarioId, JSON.stringify(state));
  }

  async replaceScenarioStates(states: ScenarioState[]): Promise<void> {
    this.database.exec("BEGIN");
    try {
      this.writeScenarioStates(states);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listScenarioInstanceStates(): Promise<ScenarioInstanceState[]> {
    return this.readScenarioInstanceStates();
  }

  async getScenarioInstanceState(scenarioInstanceId: string): Promise<ScenarioInstanceState | undefined> {
    const row = this.database.prepare("SELECT state_json FROM scenario_instance_states WHERE scenario_instance_id = ?").get(scenarioInstanceId) as
      | { state_json: string }
      | undefined;
    return row ? parseJson<ScenarioInstanceState>(row.state_json) : undefined;
  }

  async saveScenarioInstanceState(state: ScenarioInstanceState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json)
         VALUES (?, ?, ?)
         ON CONFLICT(scenario_instance_id) DO UPDATE SET scenario_pack_id = excluded.scenario_pack_id, state_json = excluded.state_json`,
      )
      .run(state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state));
  }

  async replaceScenarioInstanceStates(states: ScenarioInstanceState[]): Promise<void> {
    this.database.exec("BEGIN");
    try {
      this.writeScenarioInstanceStates(states);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getOrganizationConfig(): Promise<OrganizationConfig | undefined> {
    return this.readOrganizationConfig();
  }

  async saveOrganizationConfig(config: OrganizationConfig): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO organization_config (id, config_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json`,
      )
      .run(JSON.stringify(config));
  }

  async getDatasetMetadata(): Promise<DatasetMetadata | undefined> {
    return this.readDatasetMetadata();
  }

  async saveDatasetMetadata(metadata: DatasetMetadata): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO dataset_metadata (id, metadata_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`,
      )
      .run(JSON.stringify(metadata));
  }

  async getClockState(): Promise<SimulationClockState | undefined> {
    return this.readClockState();
  }

  async saveClockState(state: SimulationClockState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO simulation_clock_state (id, state_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(JSON.stringify(state));
  }

  async getOrchestrationState(): Promise<ContinuousOrchestrationState | undefined> {
    return this.readOrchestrationState();
  }

  async saveOrchestrationState(state: ContinuousOrchestrationState): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO continuous_orchestration_state (id, state_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(JSON.stringify(state));
  }

  async getWorldRevision(): Promise<string | undefined> {
    return this.readWorldRevision();
  }

  async saveWorldRevision(worldRevision: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO world_state (id, world_revision)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET world_revision = excluded.world_revision`,
      )
      .run(worldRevision);
  }

  async listSourceChanges(): Promise<SourceChangeLedgerEntry[]> {
    return this.readSourceChanges();
  }

  async replaceSourceChanges(changes: SourceChangeLedgerEntry[]): Promise<void> {
    this.database.exec("BEGIN");
    try {
      this.writeSourceChanges(changes);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async listSourceObjects(): Promise<SourceObjectProjection[]> {
    return this.readSourceObjects();
  }

  async replaceSourceObjects(objects: SourceObjectProjection[]): Promise<void> {
    this.database.exec("BEGIN");
    try {
      this.writeSourceObjects(objects);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async createSnapshot(snapshot: Snapshot): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO snapshots (snapshot_id, created_at, snapshot_json)
         VALUES (?, ?, ?)
         ON CONFLICT(snapshot_id) DO UPDATE SET created_at = excluded.created_at, snapshot_json = excluded.snapshot_json`,
      )
      .run(snapshot.snapshotId, snapshot.createdAt, JSON.stringify(snapshot));
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | undefined> {
    const row = this.database.prepare("SELECT snapshot_json FROM snapshots WHERE snapshot_id = ?").get(snapshotId) as
      | { snapshot_json: string }
      | undefined;
    return row ? parseJson<Snapshot>(row.snapshot_json) : undefined;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    return this.readSnapshots();
  }

  async replaceWorld(replacement: WorldReplacement, options: WorldMutationOptions = {}): Promise<void> {
    await this.mutateWorld(() => ({ replacement, result: undefined }), options);
  }

  async mutateWorld<T>(mutation: WorldMutation<T>, options: WorldMutationOptions = {}): Promise<T> {
    this.database.exec("BEGIN");
    try {
      const snapshot = this.readWorldSnapshot();
      if (options.expectedWorldRevision && snapshot.worldRevision !== options.expectedWorldRevision) throw new WorldConflictError();
      const output = await mutation(cloneJson(snapshot));
      if (this.failNextWorldReplacement) {
        this.failNextWorldReplacement = false;
        throw new Error("Injected world replacement failure");
      }
      this.writeWorldReplacement(output.replacement);
      this.database.exec("COMMIT");
      return output.result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  injectWorldReplacementFailureForTesting(): void {
    this.failNextWorldReplacement = true;
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private readWorldSnapshot(): WorldSnapshot {
    const organizationConfig = this.readOrganizationConfig();
    const worldRevision = this.readWorldRevision();
    const datasetMetadata = this.readDatasetMetadata();
    const clockState = this.readClockState();
    const orchestrationState = this.readOrchestrationState();
    return {
      scenarioStates: this.readScenarioStates(),
      scenarioInstanceStates: this.readScenarioInstanceStates(),
      ...(organizationConfig ? { organizationConfig } : {}),
      ...(worldRevision ? { worldRevision } : {}),
      sourceChanges: this.readSourceChanges(),
      sourceObjects: this.readSourceObjects(),
      ...(datasetMetadata ? { datasetMetadata } : {}),
      ...(clockState ? { clockState } : {}),
      ...(orchestrationState ? { orchestrationState } : {}),
    };
  }

  private readScenarioStates(): ScenarioState[] {
    const rows = this.database.prepare("SELECT state_json FROM scenario_states ORDER BY scenario_id").all() as Array<{ state_json: string }>;
    return rows.map((row) => parseJson<ScenarioState>(row.state_json));
  }

  private writeScenarioStates(states: ScenarioState[]): void {
    this.database.prepare("DELETE FROM scenario_states").run();
    const statement = this.database.prepare("INSERT INTO scenario_states (scenario_id, state_json) VALUES (?, ?)");
    for (const state of states) statement.run(state.scenarioId, JSON.stringify(state));
  }

  private readScenarioInstanceStates(): ScenarioInstanceState[] {
    const rows = this.database.prepare("SELECT state_json FROM scenario_instance_states ORDER BY scenario_instance_id").all() as Array<{
      state_json: string;
    }>;
    return rows.map((row) => parseJson<ScenarioInstanceState>(row.state_json));
  }

  private writeScenarioInstanceStates(states: ScenarioInstanceState[]): void {
    this.database.prepare("DELETE FROM scenario_instance_states").run();
    const statement = this.database.prepare(
      "INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES (?, ?, ?)",
    );
    for (const state of states) statement.run(state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state));
  }

  private readOrganizationConfig(): OrganizationConfig | undefined {
    const row = this.database.prepare("SELECT config_json FROM organization_config WHERE id = 'singleton'").get() as
      | { config_json: string }
      | undefined;
    return row ? parseJson<OrganizationConfig>(row.config_json) : undefined;
  }

  private readDatasetMetadata(): DatasetMetadata | undefined {
    const row = this.database.prepare("SELECT metadata_json FROM dataset_metadata WHERE id = 'singleton'").get() as
      | { metadata_json: string }
      | undefined;
    return row ? parseJson<DatasetMetadata>(row.metadata_json) : undefined;
  }

  private readClockState(): SimulationClockState | undefined {
    const row = this.database.prepare("SELECT state_json FROM simulation_clock_state WHERE id = 'singleton'").get() as
      | { state_json: string }
      | undefined;
    return row ? parseJson<SimulationClockState>(row.state_json) : undefined;
  }

  private readOrchestrationState(): ContinuousOrchestrationState | undefined {
    const row = this.database.prepare("SELECT state_json FROM continuous_orchestration_state WHERE id = 'singleton'").get() as
      | { state_json: string }
      | undefined;
    return row ? parseJson<ContinuousOrchestrationState>(row.state_json) : undefined;
  }

  private readWorldRevision(): string | undefined {
    const row = this.database.prepare("SELECT world_revision FROM world_state WHERE id = 'singleton'").get() as
      | { world_revision: string }
      | undefined;
    return row?.world_revision;
  }

  private readSourceChanges(): SourceChangeLedgerEntry[] {
    const rows = this.database.prepare("SELECT change_json FROM source_change_ledger ORDER BY ledger_sequence").all() as Array<{
      change_json: string;
    }>;
    return rows.map((row) => parseJson<SourceChangeLedgerEntry>(row.change_json));
  }

  private writeSourceChanges(changes: SourceChangeLedgerEntry[]): void {
    this.database.prepare("DELETE FROM source_change_ledger").run();
    const statement = this.database.prepare(
      "INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES (?, ?, ?)",
    );
    for (const change of changes) statement.run(change.ledgerSequence, change.worldRevision, JSON.stringify(change));
  }

  private readSourceObjects(): SourceObjectProjection[] {
    const rows = this.database.prepare("SELECT object_json FROM source_objects ORDER BY source_key").all() as Array<{ object_json: string }>;
    return rows.map((row) => parseJson<SourceObjectProjection>(row.object_json));
  }

  private writeSourceObjects(objects: SourceObjectProjection[]): void {
    this.database.prepare("DELETE FROM source_objects").run();
    const statement = this.database.prepare("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES (?, ?, ?)");
    for (const object of objects) statement.run(object.sourceKey, object.worldRevision, JSON.stringify(object));
  }

  private readSnapshots(): Snapshot[] {
    const rows = this.database.prepare("SELECT snapshot_json FROM snapshots ORDER BY created_at, snapshot_id").all() as Array<{
      snapshot_json: string;
    }>;
    return rows.map((row) => parseJson<Snapshot>(row.snapshot_json));
  }

  private writeWorldReplacement(replacement: WorldReplacement): void {
    if (replacement.scenarioStates) this.writeScenarioStates(replacement.scenarioStates);
    this.writeScenarioInstanceStates(replacement.scenarioInstanceStates);
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
    this.writeSourceChanges(replacement.sourceChanges);
    this.writeSourceObjects(replacement.sourceObjects);
    this.database
      .prepare(
        `INSERT INTO dataset_metadata (id, metadata_json)
         VALUES ('singleton', ?)
         ON CONFLICT(id) DO UPDATE SET metadata_json = excluded.metadata_json`,
      )
      .run(JSON.stringify(replacement.datasetMetadata));
    if (replacement.clockState) {
      this.database
        .prepare(
          `INSERT INTO simulation_clock_state (id, state_json)
           VALUES ('singleton', ?)
           ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`,
        )
        .run(JSON.stringify(replacement.clockState));
    }
    if (replacement.orchestrationState) {
      this.database
        .prepare(
          `INSERT INTO continuous_orchestration_state (id, state_json)
           VALUES ('singleton', ?)
           ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`,
        )
        .run(JSON.stringify(replacement.orchestrationState));
    }
  }
}

export interface PostgresSimulatorStorageOptions {
  connectionString: string;
  schema?: string;
  queryTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxPoolSize?: number;
}

export class PostgresSimulatorStorage implements SimulatorStorage {
  readonly kind = "postgres" as const;
  private readonly pool: PgPool;
  private readonly schema: string;
  private readonly queryTimeoutMs: number;
  private migrationPromise: Promise<void> | undefined;
  private closed = false;
  private failNextWorldReplacement = false;
  private lastPoolError: string | undefined;

  constructor(options: string | PostgresSimulatorStorageOptions) {
    const connectionString = typeof options === "string" ? options : options.connectionString;
    if (!connectionString.trim()) throw new Error("Postgres storage requires DATABASE_URL");
    this.schema = typeof options === "string" ? "public" : sanitizeIdentifier(options.schema ?? "public");
    this.queryTimeoutMs = typeof options === "string" ? 10_000 : options.queryTimeoutMs ?? 10_000;
    this.pool = new Pool({
      connectionString,
      connectionTimeoutMillis: typeof options === "string" ? 5_000 : options.connectionTimeoutMs ?? 5_000,
      idleTimeoutMillis: 30_000,
      max: typeof options === "string" ? 10 : options.maxPoolSize ?? 10,
      options: `-c search_path=${this.schema}`,
      query_timeout: this.queryTimeoutMs,
      statement_timeout: this.queryTimeoutMs,
    });
    this.pool.on("error", () => {
      this.lastPoolError = "postgres pool error";
    });
  }

  async health(): Promise<StorageHealth> {
    try {
      await this.ensureMigrated();
      await this.query("SELECT 1");
      return { ok: true, kind: this.kind, message: "postgres storage available" };
    } catch {
      return { ok: false, kind: this.kind, message: this.lastPoolError ?? "postgres storage unavailable" };
    }
  }

  async listScenarioStates(): Promise<ScenarioState[]> {
    const rows = await this.rows<{ state_json: string }>("list scenario states", "SELECT state_json FROM scenario_states ORDER BY scenario_id");
    return rows.map((row) => parseJson<ScenarioState>(row.state_json));
  }

  async getScenarioState(scenarioId: string): Promise<ScenarioState | undefined> {
    const rows = await this.rows<{ state_json: string }>("get scenario state", "SELECT state_json FROM scenario_states WHERE scenario_id = $1", [
      scenarioId,
    ]);
    return rows[0] ? parseJson<ScenarioState>(rows[0].state_json) : undefined;
  }

  async saveScenarioState(state: ScenarioState): Promise<void> {
    await this.query(
      `INSERT INTO scenario_states (scenario_id, state_json)
       VALUES ($1, $2)
       ON CONFLICT (scenario_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [state.scenarioId, JSON.stringify(state)],
    );
  }

  async replaceScenarioStates(states: ScenarioState[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM scenario_states");
      for (const state of states) await client.query("INSERT INTO scenario_states (scenario_id, state_json) VALUES ($1, $2)", [state.scenarioId, JSON.stringify(state)]);
    }, "replace scenario states");
  }

  async listScenarioInstanceStates(): Promise<ScenarioInstanceState[]> {
    const rows = await this.rows<{ state_json: string }>(
      "list scenario instance states",
      "SELECT state_json FROM scenario_instance_states ORDER BY scenario_instance_id",
    );
    return rows.map((row) => parseJson<ScenarioInstanceState>(row.state_json));
  }

  async getScenarioInstanceState(scenarioInstanceId: string): Promise<ScenarioInstanceState | undefined> {
    const rows = await this.rows<{ state_json: string }>(
      "get scenario instance state",
      "SELECT state_json FROM scenario_instance_states WHERE scenario_instance_id = $1",
      [scenarioInstanceId],
    );
    return rows[0] ? parseJson<ScenarioInstanceState>(rows[0].state_json) : undefined;
  }

  async saveScenarioInstanceState(state: ScenarioInstanceState): Promise<void> {
    await this.query(
      `INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (scenario_instance_id) DO UPDATE SET scenario_pack_id = EXCLUDED.scenario_pack_id, state_json = EXCLUDED.state_json`,
      [state.scenarioInstanceId, state.scenarioPackId, JSON.stringify(state)],
    );
  }

  async replaceScenarioInstanceStates(states: ScenarioInstanceState[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM scenario_instance_states");
      for (const state of states) {
        await client.query("INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES ($1, $2, $3)", [
          state.scenarioInstanceId,
          state.scenarioPackId,
          JSON.stringify(state),
        ]);
      }
    }, "replace scenario instance states");
  }

  async getOrganizationConfig(): Promise<OrganizationConfig | undefined> {
    const rows = await this.rows<{ config_json: string }>("get organization config", "SELECT config_json FROM organization_config WHERE id = 'singleton'");
    return rows[0] ? parseJson<OrganizationConfig>(rows[0].config_json) : undefined;
  }

  async saveOrganizationConfig(config: OrganizationConfig): Promise<void> {
    await this.query(
      `INSERT INTO organization_config (id, config_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json`,
      [JSON.stringify(config)],
    );
  }

  async getDatasetMetadata(): Promise<DatasetMetadata | undefined> {
    const rows = await this.rows<{ metadata_json: string }>("get dataset metadata", "SELECT metadata_json FROM dataset_metadata WHERE id = 'singleton'");
    return rows[0] ? parseJson<DatasetMetadata>(rows[0].metadata_json) : undefined;
  }

  async saveDatasetMetadata(metadata: DatasetMetadata): Promise<void> {
    await this.query(
      `INSERT INTO dataset_metadata (id, metadata_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json`,
      [JSON.stringify(metadata)],
    );
  }

  async getClockState(): Promise<SimulationClockState | undefined> {
    const rows = await this.rows<{ state_json: string }>("get simulation clock", "SELECT state_json FROM simulation_clock_state WHERE id = 'singleton'");
    return rows[0] ? parseJson<SimulationClockState>(rows[0].state_json) : undefined;
  }

  async saveClockState(state: SimulationClockState): Promise<void> {
    await this.query(
      `INSERT INTO simulation_clock_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(state)],
    );
  }

  async getOrchestrationState(): Promise<ContinuousOrchestrationState | undefined> {
    const rows = await this.rows<{ state_json: string }>(
      "get continuous orchestration",
      "SELECT state_json FROM continuous_orchestration_state WHERE id = 'singleton'",
    );
    return rows[0] ? parseJson<ContinuousOrchestrationState>(rows[0].state_json) : undefined;
  }

  async saveOrchestrationState(state: ContinuousOrchestrationState): Promise<void> {
    await this.query(
      `INSERT INTO continuous_orchestration_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(state)],
    );
  }

  async getWorldRevision(): Promise<string | undefined> {
    const rows = await this.rows<{ world_revision: string }>("get world revision", "SELECT world_revision FROM world_state WHERE id = 'singleton'");
    return rows[0]?.world_revision;
  }

  async saveWorldRevision(worldRevision: string): Promise<void> {
    await this.query(
      `INSERT INTO world_state (id, world_revision)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET world_revision = EXCLUDED.world_revision`,
      [worldRevision],
    );
  }

  async listSourceChanges(): Promise<SourceChangeLedgerEntry[]> {
    const rows = await this.rows<{ change_json: string }>("list source changes", "SELECT change_json FROM source_change_ledger ORDER BY ledger_sequence");
    return rows.map((row) => parseJson<SourceChangeLedgerEntry>(row.change_json));
  }

  async replaceSourceChanges(changes: SourceChangeLedgerEntry[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM source_change_ledger");
      await writePostgresSourceChanges(client, changes);
    }, "replace source changes");
  }

  async listSourceObjects(): Promise<SourceObjectProjection[]> {
    const rows = await this.rows<{ object_json: string }>("list source objects", "SELECT object_json FROM source_objects ORDER BY source_key");
    return rows.map((row) => parseJson<SourceObjectProjection>(row.object_json));
  }

  async replaceSourceObjects(objects: SourceObjectProjection[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("DELETE FROM source_objects");
      await writePostgresSourceObjects(client, objects);
    }, "replace source objects");
  }

  async createSnapshot(snapshot: Snapshot): Promise<void> {
    await this.query(
      `INSERT INTO snapshots (snapshot_id, created_at, snapshot_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (snapshot_id) DO UPDATE SET created_at = EXCLUDED.created_at, snapshot_json = EXCLUDED.snapshot_json`,
      [snapshot.snapshotId, snapshot.createdAt, JSON.stringify(snapshot)],
    );
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot | undefined> {
    const rows = await this.rows<{ snapshot_json: string }>("get snapshot", "SELECT snapshot_json FROM snapshots WHERE snapshot_id = $1", [snapshotId]);
    return rows[0] ? parseJson<Snapshot>(rows[0].snapshot_json) : undefined;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    const rows = await this.rows<{ snapshot_json: string }>("list snapshots", "SELECT snapshot_json FROM snapshots ORDER BY created_at, snapshot_id");
    return rows.map((row) => parseJson<Snapshot>(row.snapshot_json));
  }

  async replaceWorld(replacement: WorldReplacement, options: WorldMutationOptions = {}): Promise<void> {
    await this.mutateWorld(() => ({ replacement, result: undefined }), options);
  }

  async mutateWorld<T>(mutation: WorldMutation<T>, options: WorldMutationOptions = {}): Promise<T> {
    await this.ensureMigrated();
    return this.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(${POSTGRES_WORLD_LOCK_ID})`);
      const snapshot = await readPostgresWorldSnapshot(client);
      if (options.expectedWorldRevision && snapshot.worldRevision !== options.expectedWorldRevision) throw new WorldConflictError();
      const output = await mutation(cloneJson(snapshot));
      if (this.failNextWorldReplacement) {
        this.failNextWorldReplacement = false;
        throw new Error("Injected world replacement failure");
      }
      await writePostgresWorldReplacement(client, output.replacement, snapshot);
      return output.result;
    }, "mutate world");
  }

  injectWorldReplacementFailureForTesting(): void {
    this.failNextWorldReplacement = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  async dropOwnedSchemaForTesting(): Promise<void> {
    if (!this.schema.startsWith("sim_test_") && !this.schema.startsWith("sim_benchmark_")) {
      throw new Error("Refusing to drop a non-test Postgres schema");
    }
    const client = await this.pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(this.schema)} CASCADE`);
    } finally {
      client.release();
    }
  }

  async checkRateLimit(input: StorageRateLimitInput): Promise<StorageRateLimitDecision> {
    await this.ensureMigrated();
    return this.transaction(async (client) => {
      const cleanupBefore = input.nowMs - input.windowMs * 2;
      await client.query(
        `DELETE FROM rate_limit_buckets
         WHERE expires_at_ms < $1
         AND (scope, identity_key) IN (
           SELECT scope, identity_key FROM rate_limit_buckets WHERE expires_at_ms < $1 LIMIT 100
        )`,
        [cleanupBefore],
      );
      const bucket = (
        await client.query<{ window_started_at_ms: string; request_count: number }>(
          `INSERT INTO rate_limit_buckets (scope, identity_key, window_started_at_ms, request_count, expires_at_ms)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (scope, identity_key)
           DO UPDATE SET
             window_started_at_ms = CASE
               WHEN $3 - rate_limit_buckets.window_started_at_ms >= $5 THEN $3
               ELSE rate_limit_buckets.window_started_at_ms
             END,
             request_count = CASE
               WHEN $3 - rate_limit_buckets.window_started_at_ms >= $5 THEN 1
               ELSE rate_limit_buckets.request_count + 1
             END,
             expires_at_ms = CASE
               WHEN $3 - rate_limit_buckets.window_started_at_ms >= $5 THEN $4
               ELSE rate_limit_buckets.window_started_at_ms + $5
             END
           RETURNING window_started_at_ms, request_count`,
          [input.scope, input.identityKey, input.nowMs, input.nowMs + input.windowMs, input.windowMs],
        )
      ).rows[0]!;
      if (bucket.request_count <= input.limit) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((input.windowMs - (input.nowMs - Number(bucket.window_started_at_ms))) / 1_000)),
      };
    }, "check rate limit");
  }

  private async rows<T>(operation: string, sql: string, values: unknown[] = []): Promise<T[]> {
    return (await this.query(sql, values, operation)).rows as T[];
  }

  private async query(sql: string, values: unknown[] = [], operation = "postgres query"): Promise<QueryResult> {
    await this.ensureMigrated();
    try {
      return await this.pool.query(sql, values);
    } catch (error) {
      if (error instanceof WorldConflictError) throw error;
      throw safeStorageError(operation, error);
    }
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>, operation: string): Promise<T> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${this.queryTimeoutMs}`);
      await client.query(`SET LOCAL search_path = ${quoteIdentifier(this.schema)}`);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best effort rollback
      }
      if (error instanceof WorldConflictError) throw error;
      throw safeStorageError(operation, error);
    } finally {
      client.release();
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (this.migrationPromise) return this.migrationPromise;
    this.migrationPromise = this.runMigrations();
    return this.migrationPromise;
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
      await client.query(`SET LOCAL search_path = ${quoteIdentifier(this.schema)}`);
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      for (const migration of POSTGRES_MIGRATIONS) {
        const sql = await readFile(new URL(migration.path, import.meta.url), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = (
          await client.query<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = $1", [migration.version])
        ).rows[0];
        if (existing && existing.checksum !== checksum) throw new StorageError("Postgres migration checksum mismatch");
        if (!existing) {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)", [
            migration.version,
            checksum,
            new Date().toISOString(),
          ]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best effort rollback
      }
      throw safeStorageError("migrate postgres storage", error);
    } finally {
      client.release();
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

function safeStorageError(operation: string, error: unknown): Error {
  if (error instanceof WorldConflictError || error instanceof StorageError) return error;
  if (isSimulatorDomainError(error)) return error;
  if (error instanceof Error && error.message === "Injected world replacement failure") return error;
  return new StorageError(`${operation} failed`);
}

function isSimulatorDomainError(error: unknown): error is Error {
  return error instanceof Error && "status" in error && "classification" in error;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid Postgres schema identifier");
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${sanitizeIdentifier(value).replaceAll('"', '""')}"`;
}

async function readPostgresWorldSnapshot(client: PoolClient): Promise<WorldSnapshot> {
  const scenarioStates = (await client.query<{ state_json: string }>("SELECT state_json FROM scenario_states ORDER BY scenario_id")).rows.map((row) =>
    parseJson<ScenarioState>(row.state_json),
  );
  const scenarioInstanceStates = (
    await client.query<{ state_json: string }>("SELECT state_json FROM scenario_instance_states ORDER BY scenario_instance_id")
  ).rows.map((row) => parseJson<ScenarioInstanceState>(row.state_json));
  const organizationRow = (await client.query<{ config_json: string }>("SELECT config_json FROM organization_config WHERE id = 'singleton'")).rows[0];
  const worldRow = (await client.query<{ world_revision: string }>("SELECT world_revision FROM world_state WHERE id = 'singleton'")).rows[0];
  const sourceChanges = (await client.query<{ change_json: string }>("SELECT change_json FROM source_change_ledger ORDER BY ledger_sequence")).rows.map(
    (row) => parseJson<SourceChangeLedgerEntry>(row.change_json),
  );
  const sourceObjects = (await client.query<{ object_json: string }>("SELECT object_json FROM source_objects ORDER BY source_key")).rows.map((row) =>
    parseJson<SourceObjectProjection>(row.object_json),
  );
  const metadataRow = (await client.query<{ metadata_json: string }>("SELECT metadata_json FROM dataset_metadata WHERE id = 'singleton'")).rows[0];
  const clockRow = (await client.query<{ state_json: string }>("SELECT state_json FROM simulation_clock_state WHERE id = 'singleton'")).rows[0];
  const orchestrationRow = (await client.query<{ state_json: string }>("SELECT state_json FROM continuous_orchestration_state WHERE id = 'singleton'")).rows[0];
  return {
    scenarioStates,
    scenarioInstanceStates,
    ...(organizationRow ? { organizationConfig: parseJson<OrganizationConfig>(organizationRow.config_json) } : {}),
    ...(worldRow ? { worldRevision: worldRow.world_revision } : {}),
    sourceChanges,
    sourceObjects,
    ...(metadataRow ? { datasetMetadata: parseJson<DatasetMetadata>(metadataRow.metadata_json) } : {}),
    ...(clockRow ? { clockState: parseJson<SimulationClockState>(clockRow.state_json) } : {}),
    ...(orchestrationRow ? { orchestrationState: parseJson<ContinuousOrchestrationState>(orchestrationRow.state_json) } : {}),
  };
}

async function writePostgresWorldReplacement(
  client: PoolClient,
  replacement: WorldReplacement,
  snapshot?: WorldSnapshot,
): Promise<void> {
  if (snapshot && canWritePostgresWorldPatch(snapshot, replacement)) {
    await writePostgresWorldPatch(client, snapshot, replacement);
    return;
  }
  if (replacement.scenarioStates) {
    await client.query("DELETE FROM scenario_states");
    for (const state of replacement.scenarioStates) {
      await client.query("INSERT INTO scenario_states (scenario_id, state_json) VALUES ($1, $2)", [state.scenarioId, JSON.stringify(state)]);
    }
  }
  await client.query("DELETE FROM scenario_instance_states");
  for (const state of replacement.scenarioInstanceStates) {
    await client.query("INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json) VALUES ($1, $2, $3)", [
      state.scenarioInstanceId,
      state.scenarioPackId,
      JSON.stringify(state),
    ]);
  }
  if (replacement.organizationConfig) {
    await client.query(
      `INSERT INTO organization_config (id, config_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET config_json = EXCLUDED.config_json`,
      [JSON.stringify(replacement.organizationConfig)],
    );
  }
  await client.query(
    `INSERT INTO world_state (id, world_revision)
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET world_revision = EXCLUDED.world_revision`,
    [replacement.worldRevision],
  );
  await client.query("DELETE FROM source_change_ledger");
  await writePostgresSourceChanges(client, replacement.sourceChanges);
  await client.query("DELETE FROM source_objects");
  await writePostgresSourceObjects(client, replacement.sourceObjects);
  await client.query(
    `INSERT INTO dataset_metadata (id, metadata_json)
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json`,
    [JSON.stringify(replacement.datasetMetadata)],
  );
  if (replacement.clockState) {
    await client.query(
      `INSERT INTO simulation_clock_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(replacement.clockState)],
    );
  }
  if (replacement.orchestrationState) {
    await client.query(
      `INSERT INTO continuous_orchestration_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(replacement.orchestrationState)],
    );
  }
}

function canWritePostgresWorldPatch(
  snapshot: WorldSnapshot,
  replacement: WorldReplacement,
): boolean {
  if (!snapshot.worldRevision || snapshot.worldRevision !== replacement.worldRevision) return false;
  if (replacement.scenarioStates) return false;
  if (
    replacement.organizationConfig &&
    JSON.stringify(replacement.organizationConfig) !== JSON.stringify(snapshot.organizationConfig)
  ) {
    return false;
  }
  if (!containsAllScenarioInstances(snapshot.scenarioInstanceStates, replacement.scenarioInstanceStates)) return false;
  if (!containsAllSourceObjects(snapshot.sourceObjects, replacement.sourceObjects)) return false;
  return sourceChangesAreAppendOnly(snapshot.sourceChanges, replacement.sourceChanges);
}

function containsAllScenarioInstances(
  before: ScenarioInstanceState[],
  after: ScenarioInstanceState[],
): boolean {
  const afterIds = new Set(after.map((state) => state.scenarioInstanceId));
  return before.every((state) => afterIds.has(state.scenarioInstanceId));
}

function containsAllSourceObjects(
  before: SourceObjectProjection[],
  after: SourceObjectProjection[],
): boolean {
  const afterKeys = new Set(after.map((object) => object.sourceKey));
  return before.every((object) => afterKeys.has(object.sourceKey));
}

function sourceChangesAreAppendOnly(
  before: SourceChangeLedgerEntry[],
  after: SourceChangeLedgerEntry[],
): boolean {
  if (after.length < before.length) return false;
  for (const [index, beforeChange] of before.entries()) {
    const afterChange = after[index];
    if (!afterChange) return false;
    if (beforeChange.ledgerSequence !== afterChange.ledgerSequence) return false;
    if (beforeChange.changeId !== afterChange.changeId) return false;
    if (JSON.stringify(beforeChange) !== JSON.stringify(afterChange)) return false;
  }
  return true;
}

async function writePostgresWorldPatch(
  client: PoolClient,
  snapshot: WorldSnapshot,
  replacement: WorldReplacement,
): Promise<void> {
  const previousInstances = new Map(
    snapshot.scenarioInstanceStates.map((state) => [
      state.scenarioInstanceId,
      JSON.stringify(state),
    ]),
  );
  for (const state of replacement.scenarioInstanceStates) {
    const stateJson = JSON.stringify(state);
    if (previousInstances.get(state.scenarioInstanceId) === stateJson) continue;
    await client.query(
      `INSERT INTO scenario_instance_states (scenario_instance_id, scenario_pack_id, state_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (scenario_instance_id)
       DO UPDATE SET scenario_pack_id = EXCLUDED.scenario_pack_id, state_json = EXCLUDED.state_json`,
      [state.scenarioInstanceId, state.scenarioPackId, stateJson],
    );
  }
  await client.query(
    `INSERT INTO world_state (id, world_revision)
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET world_revision = EXCLUDED.world_revision`,
    [replacement.worldRevision],
  );
  await writePostgresSourceChanges(
    client,
    replacement.sourceChanges.slice(snapshot.sourceChanges.length),
  );
  const previousObjects = new Map(
    snapshot.sourceObjects.map((object) => [object.sourceKey, JSON.stringify(object)]),
  );
  for (const object of replacement.sourceObjects) {
    const objectJson = JSON.stringify(object);
    if (previousObjects.get(object.sourceKey) === objectJson) continue;
    await client.query(
      `INSERT INTO source_objects (source_key, world_revision, object_json)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_key)
       DO UPDATE SET world_revision = EXCLUDED.world_revision, object_json = EXCLUDED.object_json`,
      [object.sourceKey, object.worldRevision, objectJson],
    );
  }
  await client.query(
    `INSERT INTO dataset_metadata (id, metadata_json)
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json`,
    [JSON.stringify(replacement.datasetMetadata)],
  );
  if (replacement.clockState) {
    await client.query(
      `INSERT INTO simulation_clock_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(replacement.clockState)],
    );
  }
  if (replacement.orchestrationState) {
    await client.query(
      `INSERT INTO continuous_orchestration_state (id, state_json)
       VALUES ('singleton', $1)
       ON CONFLICT (id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [JSON.stringify(replacement.orchestrationState)],
    );
  }
}

async function writePostgresSourceChanges(client: PoolClient, changes: SourceChangeLedgerEntry[]): Promise<void> {
  for (const change of changes) {
    await client.query("INSERT INTO source_change_ledger (ledger_sequence, world_revision, change_json) VALUES ($1, $2, $3)", [
      change.ledgerSequence,
      change.worldRevision,
      JSON.stringify(change),
    ]);
  }
}

async function writePostgresSourceObjects(client: PoolClient, objects: SourceObjectProjection[]): Promise<void> {
  for (const object of objects) {
    await client.query("INSERT INTO source_objects (source_key, world_revision, object_json) VALUES ($1, $2, $3)", [
      object.sourceKey,
      object.worldRevision,
      JSON.stringify(object),
    ]);
  }
}
