import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { scenarios } from "./data.js";
import { type DatasetSize, datasetSizes } from "./domain.js";
import { SourceSimulator } from "./engine.js";
import { MemorySimulatorStorage, PostgresSimulatorStorage, SQLiteSimulatorStorage, type SimulatorStorage, type StorageKind } from "./storage.js";

export const BenchmarkRequestSchema = z
  .object({
    storage: z.enum(["memory", "sqlite", "postgres"]).default("memory"),
    seed: z.string().min(1).max(128).default("benchmark-seed"),
    datasetSizes: z.array(z.enum(datasetSizes)).min(1).max(3).default(["small", "medium", "large"]),
  })
  .strict();

export type BenchmarkRequest = z.infer<typeof BenchmarkRequestSchema>;

export interface BenchmarkOperationResult {
  durationMs: number;
}

export interface BenchmarkDatasetResult {
  datasetSize: DatasetSize;
  storage: StorageKind;
  storageTarget: "ephemeral-memory" | "temporary-sqlite" | "benchmark-postgres-schema";
  counts: {
    scenarioInstances: number;
    sourceChanges: number;
    sourceObjects: number;
    organizationPeople: number;
  };
  operations: {
    generate: BenchmarkOperationResult;
    advance: BenchmarkOperationResult;
    trigger: BenchmarkOperationResult;
    feed: BenchmarkOperationResult & { records: number; hasMore: boolean };
    snapshot: BenchmarkOperationResult;
    restore: BenchmarkOperationResult;
    organizationRegeneration: BenchmarkOperationResult;
  };
}

export interface BenchmarkReport {
  schemaVersion: "simulator-performance-benchmark.v1";
  generatedAt: string;
  seed: string;
  storage: StorageKind;
  results: BenchmarkDatasetResult[];
}

export interface BenchmarkRuntimeOptions {
  applicationDatabaseUrl?: string;
  benchmarkDatabaseUrl?: string;
  runtimeEnv?: "development" | "test" | "preview" | "production";
}

export async function runPerformanceBenchmark(input: BenchmarkRequest, options: BenchmarkRuntimeOptions = {}): Promise<BenchmarkReport> {
  const request = BenchmarkRequestSchema.parse(input);
  const results: BenchmarkDatasetResult[] = [];
  for (const datasetSize of request.datasetSizes) {
    results.push(await runDatasetBenchmark(request.storage, request.seed, datasetSize, options));
  }
  return {
    schemaVersion: "simulator-performance-benchmark.v1",
    generatedAt: new Date().toISOString(),
    seed: request.seed,
    storage: request.storage,
    results,
  };
}

async function runDatasetBenchmark(
  storageKind: StorageKind,
  seed: string,
  datasetSize: DatasetSize,
  options: BenchmarkRuntimeOptions,
): Promise<BenchmarkDatasetResult> {
  const { storage, storageTarget, cleanup } = createBenchmarkStorage(storageKind, datasetSize, options);
  try {
    const simulator = await SourceSimulator.create({ seed, datasetSize, storage, baseUrl: "http://sim.test" });
    const generate = await measure(() => simulator.generateDataset({ seed: `${seed}-${datasetSize}`, datasetSize }));
    const targetInstance = (await simulator.states())[0]!;
    const advance = await measure(() => simulator.advanceScenarioInstance(targetInstance.scenarioInstanceId, { hours: 6 }));
    const triggerInstanceId = `benchmark-${datasetSize}-manual-trigger`;
    const triggerPack = scenarios.find((scenario) => scenario.events.some((event) => event.manual))!;
    await simulator.createScenarioInstance({
      scenarioPackId: triggerPack.id,
      scenarioInstanceId: triggerInstanceId,
      seed: `${seed}-${datasetSize}-trigger`,
      datasetSize,
    });
    const manualEvent = triggerPack.events.find((event) => event.manual)!;
    const trigger = await measure(() => simulator.triggerScenarioInstanceEvent(triggerInstanceId, manualEvent.id));
    const feed = await measure(() => simulator.feed("conn-product-manager", undefined, 100));
    const snapshot = await measure(() => simulator.createSnapshot());
    const restore = await measure(() => simulator.restoreSnapshot(snapshot.value.snapshotId));
    const organizationRegeneration = await measure(() => simulator.regenerateOrganization({ seed: `${seed}-${datasetSize}-org` }));
    const metadata = await simulator.datasetMetadata();
    return {
      datasetSize,
      storage: storageKind,
      storageTarget,
      counts: {
        scenarioInstances: metadata.scenarioInstanceCount,
        sourceChanges: metadata.totalSourceChanges,
        sourceObjects: metadata.totalSourceObjects,
        organizationPeople: simulator.organizationSummary().counts.totalPeople,
      },
      operations: {
        generate: { durationMs: generate.durationMs },
        advance: { durationMs: advance.durationMs },
        trigger: { durationMs: trigger.durationMs },
        feed: { durationMs: feed.durationMs, records: feed.value.records.length, hasMore: feed.value.hasMore },
        snapshot: { durationMs: snapshot.durationMs },
        restore: { durationMs: restore.durationMs },
        organizationRegeneration: { durationMs: organizationRegeneration.durationMs },
      },
    };
  } finally {
    await cleanup?.();
    await storage.close?.();
  }
}

function createBenchmarkStorage(
  storageKind: StorageKind,
  datasetSize: DatasetSize,
  options: BenchmarkRuntimeOptions,
): { storage: SimulatorStorage; storageTarget: BenchmarkDatasetResult["storageTarget"]; cleanup?: () => Promise<void> } {
  if (storageKind === "memory") return { storage: new MemorySimulatorStorage(), storageTarget: "ephemeral-memory" };
  if (storageKind === "sqlite") {
    return {
      storage: new SQLiteSimulatorStorage(join(mkdtempSync(join(tmpdir(), "source-sim-benchmark-")), "benchmark.sqlite")),
      storageTarget: "temporary-sqlite",
    };
  }
  if (!options.benchmarkDatabaseUrl?.startsWith("postgres")) {
    throw new Error("Postgres benchmark requires SIMULATOR_BENCHMARK_DATABASE_URL");
  }
  assertBenchmarkDatabaseIsIsolated(options.applicationDatabaseUrl, options.benchmarkDatabaseUrl);
  const schema = `sim_benchmark_${process.pid}_${Date.now()}_${datasetSize}`.replaceAll(/[^A-Za-z0-9_]/g, "_");
  const storage = new PostgresSimulatorStorage({ connectionString: options.benchmarkDatabaseUrl, schema });
  return {
    storage,
    storageTarget: "benchmark-postgres-schema",
    cleanup: () => storage.dropOwnedSchemaForTesting(),
  };
}

export function assertBenchmarkDatabaseIsIsolated(applicationDatabaseUrl: string | undefined, benchmarkDatabaseUrl: string): void {
  if (!applicationDatabaseUrl?.trim()) return;
  if (normalizeDatabaseUrl(applicationDatabaseUrl) === normalizeDatabaseUrl(benchmarkDatabaseUrl)) {
    throw new Error("Postgres benchmark database must be separate from DATABASE_URL");
  }
}

function normalizeDatabaseUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.sort();
  url.hash = "";
  return url.toString();
}

async function measure<T>(callback: () => T | Promise<T>): Promise<{ durationMs: number; value: T }> {
  const started = performance.now();
  const value = await callback();
  return { durationMs: Math.round((performance.now() - started) * 100) / 100, value };
}
