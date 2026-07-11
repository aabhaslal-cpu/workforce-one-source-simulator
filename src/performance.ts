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

export function runPerformanceBenchmark(input: BenchmarkRequest, databaseUrl = process.env.DATABASE_URL): BenchmarkReport {
  const request = BenchmarkRequestSchema.parse(input);
  const results = request.datasetSizes.map((datasetSize) => runDatasetBenchmark(request.storage, request.seed, datasetSize, databaseUrl));
  return {
    schemaVersion: "simulator-performance-benchmark.v1",
    generatedAt: new Date().toISOString(),
    seed: request.seed,
    storage: request.storage,
    results,
  };
}

function runDatasetBenchmark(storageKind: StorageKind, seed: string, datasetSize: DatasetSize, databaseUrl: string | undefined): BenchmarkDatasetResult {
  const storage = createBenchmarkStorage(storageKind, databaseUrl);
  try {
    const simulator = new SourceSimulator({ seed, datasetSize, storage, baseUrl: "http://sim.test" });
    const generate = measure(() => simulator.generateDataset({ seed: `${seed}-${datasetSize}`, datasetSize }));
    const targetInstance = simulator.states()[0]!;
    const advance = measure(() => simulator.advanceScenarioInstance(targetInstance.scenarioInstanceId, { hours: 6 }));
    const triggerInstanceId = `benchmark-${datasetSize}-manual-trigger`;
    const triggerPack = scenarios.find((scenario) => scenario.events.some((event) => event.manual))!;
    simulator.createScenarioInstance({
      scenarioPackId: triggerPack.id,
      scenarioInstanceId: triggerInstanceId,
      seed: `${seed}-${datasetSize}-trigger`,
      datasetSize,
    });
    const manualEvent = triggerPack.events.find((event) => event.manual)!;
    const trigger = measure(() => simulator.triggerScenarioInstanceEvent(triggerInstanceId, manualEvent.id));
    const feed = measure(() => simulator.feed("conn-product-manager", undefined, 100));
    const snapshot = measure(() => simulator.createSnapshot());
    const snapshotId = snapshot.value.snapshotId;
    const restore = measure(() => simulator.restoreSnapshot(snapshotId));
    const organizationRegeneration = measure(() => simulator.regenerateOrganization({ seed: `${seed}-${datasetSize}-org` }));
    const metadata = simulator.datasetMetadata();
    return {
      datasetSize,
      storage: storageKind,
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
    storage.close?.();
  }
}

function createBenchmarkStorage(storageKind: StorageKind, databaseUrl: string | undefined): SimulatorStorage {
  if (storageKind === "memory") return new MemorySimulatorStorage();
  if (storageKind === "sqlite") {
    return new SQLiteSimulatorStorage(join(mkdtempSync(join(tmpdir(), "source-sim-benchmark-")), "benchmark.sqlite"));
  }
  if (!databaseUrl?.startsWith("postgres")) {
    throw new Error("Postgres benchmark requires DATABASE_URL");
  }
  return new PostgresSimulatorStorage({ connectionString: databaseUrl, resetForTesting: true });
}

function measure<T>(callback: () => T): { durationMs: number; value: T } {
  const started = performance.now();
  const value = callback();
  return { durationMs: Math.round((performance.now() - started) * 100) / 100, value };
}
