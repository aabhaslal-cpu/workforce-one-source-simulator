import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceFeedBatchV1Schema } from "../contracts.js";
import { SourceSimulator } from "../engine.js";
import { createApp } from "../app.js";
import { sourceAdapters } from "../adapters/registry.js";
import { defaultOrganizationConfig, personConnectionId } from "../organization.js";
import { MemorySimulatorStorage, PostgresSimulatorStorage, SQLiteSimulatorStorage } from "../storage.js";
import { sourceSystems } from "../domain.js";
import { assertBenchmarkDatabaseIsIsolated } from "../performance.js";

type TestSQLiteStatement = {
  all(...parameters: unknown[]): unknown[];
};

type TestSQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): TestSQLiteStatement;
  close(): void;
};

const require = createRequire(import.meta.url);

async function advancedSimulator(seed = "test-seed") {
  const simulator = await SourceSimulator.create({ seed, baseUrl: "http://sim.test" });
  await simulator.advanceScenario("product-launch-readiness", { hours: 48 });
  await simulator.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
  await simulator.advanceScenario("reliability-incident", { hours: 48 });
  await simulator.advanceScenario("renewal-risk", { hours: 48 });
  return simulator;
}

async function completedDatasetSimulator(seed = "dataset-seed", datasetSize: "small" | "medium" | "large" = "small") {
  const simulator = await SourceSimulator.create({ seed, datasetSize, baseUrl: "http://sim.test" });
  await simulator.generateDataset({ seed, datasetSize });
  return simulator;
}

async function credentialedApp(simulatorPromise?: Promise<SourceSimulator> | SourceSimulator) {
  const simulator = simulatorPromise ? await simulatorPromise : await advancedSimulator();
  const credentials = {
    "secret-product-manager": "conn-product-manager",
    "secret-product-ic": "conn-product-ic",
    "secret-product-vp": "conn-product-vp",
    "secret-cs-manager": "conn-customer-success-manager",
  };
  return {
    simulator,
    app: await createApp({
      simulator,
      runtimeEnv: "test",
      adminKey: "admin-test",
      connectionCredentials: credentials,
      revokedConnectionCredentials: ["revoked-connection"],
    }),
  };
}

function adminHeaders() {
  return { "x-admin-api-key": "admin-test" };
}

function connectionHeaders(secret: string) {
  return { "x-connection-secret": secret };
}

function developmentConnectionHeaders(connectionId: string) {
  return connectionHeaders(`dev-connection-secret:${connectionId}`);
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
}

function cloneDefaultOrganizationConfig() {
  return JSON.parse(JSON.stringify(defaultOrganizationConfig));
}

async function withEnv<T>(overrides: Record<string, string | undefined>, callback: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function openTestSQLiteDatabase(filename: string): TestSQLiteDatabase {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (filename: string) => TestSQLiteDatabase };
  return new sqlite.DatabaseSync(filename);
}

function durableTableSql(database: TestSQLiteDatabase): Record<string, string> {
  const rows = database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ORDER BY name").all(
    "scenario_states",
    "scenario_instance_states",
    "organization_config",
    "snapshots",
    "world_state",
    "source_change_ledger",
    "source_objects",
    "dataset_metadata",
    "simulation_clock_state",
    "continuous_orchestration_state",
  ) as Array<{ name: string; sql: string }>;
  return Object.fromEntries(rows.map((row) => [row.name, normalizeSql(row.sql)]));
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function addHoursIso(start: string, hours: number): string {
  const date = new Date(start);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

async function storageWorldSnapshot(simulator: SourceSimulator) {
  return {
    worldRevision: (await simulator.datasetMetadata()).worldRevision,
    metadata: await simulator.datasetMetadata(),
    instanceStates: await simulator.states(),
    sourceChanges: await simulator.sourceChanges(),
    sourceObjects: await simulator.sourceObjects(),
  };
}

const postgresTestUrl = process.env.SIMULATOR_POSTGRES_TEST_URL;
const describePostgres = postgresTestUrl ? describe : describe.skip;

describe("organization generation", () => {
  it("generates a deterministic multi-person reporting hierarchy", async () => {
    const first = await SourceSimulator.create({ seed: "org-seed" });
    const second = await SourceSimulator.create({ seed: "org-seed" });
    const firstPeople = first.people().map((person) => person.id);
    const secondPeople = second.people().map((person) => person.id);

    expect(firstPeople).toEqual(secondPeople);
    expect(first.organizationSummary().validation.ok).toBe(true);
    expect(first.organizationSummary().counts.byRoleLevel.vp).toBeGreaterThanOrEqual(3);
    expect(first.organizationSummary().counts.byRoleLevel.director).toBeGreaterThan(3);
    expect(first.organizationSummary().counts.byRoleLevel.manager).toBeGreaterThan(6);
    expect(first.organizationSummary().counts.byRoleLevel.ic).toBeGreaterThan(24);
  });

  it("keeps reporting hierarchy separate from source visibility", async () => {
    const simulator = await advancedSimulator();
    const productIc = simulator.people().find((person) => person.roleTemplateId === "role-product-ic");
    const productVp = simulator.people().find((person) => person.roleTemplateId === "role-product-vp");
    expect(productIc?.managerId).toEqual(expect.any(String));
    expect(productVp?.managerId).toBeNull();
    expect(productVp?.directReportIds.length).toBeGreaterThan(0);

    const icRecords = (await simulator.recordsForPerson(productIc!.id)).records;
    const vpRecords = (await simulator.recordsForPerson(productVp!.id)).records;
    expect(icRecords.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(vpRecords.some((record) => record.title === "Launch date question for staff")).toBe(true);
  });

  it("preserves cycle-free hierarchy integrity", async () => {
    const simulator = await SourceSimulator.create({ seed: "hierarchy-check" });
    const people = simulator.people();
    const byId = new Map(people.map((person) => [person.id, person]));

    for (const person of people) {
      if (person.managerId) {
        const manager = byId.get(person.managerId);
        expect(manager).toBeDefined();
        expect(manager?.directReportIds).toContain(person.id);
      }
      const visited = new Set<string>();
      let current = person;
      while (current.managerId) {
        expect(visited.has(current.id)).toBe(false);
        visited.add(current.id);
        current = byId.get(current.managerId)!;
      }
    }
  });
});

describe("SourceSimulator", () => {
  it("produces deterministic records for the same seed and state", async () => {
    const firstSimulator = await advancedSimulator("same-seed");
    const secondSimulator = await advancedSimulator("same-seed");
    const differentSimulator = await advancedSimulator("different-seed");
    const first = (await firstSimulator.allRecords()).map((record) => record.sourceId);
    const second = (await secondSimulator.allRecords()).map((record) => record.sourceId);
    const different = (await differentSimulator.allRecords()).map((record) => record.sourceId);

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  it("paginates connection feeds with an opaque idempotent cursor", async () => {
    const simulator = await advancedSimulator();
    const first = await simulator.feed("conn-product-manager", undefined, 2);
    const second = await simulator.feed("conn-product-manager", first.nextCursor, 2);
    const retry = await simulator.feed("conn-product-manager", first.nextCursor, 2);

    expect(SourceFeedBatchV1Schema.parse(first)).toEqual(first);
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.records.map((record) => record.changeId)).toEqual(retry.records.map((record) => record.changeId));
    expect(new Set([...first.records, ...second.records].map((record) => record.changeId)).size).toBe(4);
  });

  it("uses a compact v3 checkpoint cursor even for large ledgers", async () => {
    const simulator = await completedDatasetSimulator("large-cursor-seed", "large");
    const first = await simulator.feed("conn-product-manager", undefined, 100);
    const cursorPayload = decodeCursor(first.nextCursor);

    expect((await simulator.datasetMetadata()).totalSourceChanges).toBeGreaterThanOrEqual(5_000);
    expect(first.nextCursor.length).toBeLessThan(256);
    expect(cursorPayload).toMatchObject({
      v: 3,
      connectionId: "conn-product-manager",
      worldRevision: (await simulator.datasetMetadata()).worldRevision,
    });
    expect(cursorPayload.consumedChangeIds).toBeUndefined();
  });

  it("rejects stale cursors after a world revision change", async () => {
    const simulator = await SourceSimulator.create({ seed: "stale-cursor-seed" });
    const first = await simulator.feed("conn-product-manager", undefined, 10);
    await simulator.resetScenario("product-launch-readiness", { seed: "new-scenario-seed" });

    await expect(simulator.feed("conn-product-manager", first.nextCursor, 10)).rejects.toThrow("Stale checkpoint");
  });

  it("continues from a saved change checkpoint after new creates and updates", async () => {
    const simulator = await SourceSimulator.create({ seed: "checkpoint-seed", baseUrl: "http://sim.test" });
    const initial = await simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initial.nextCursor;
    const initiallyConsumed = new Set(initial.records.map((record) => record.changeId));

    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const createdPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(retryCreatedPage.records.map((record) => record.changeId));
    expect(createdPage.records.every((record) => !initiallyConsumed.has(record.changeId))).toBe(true);

    const createdDependency = createdPage.records.find((record) => record.title === "Workflow export API dependency");
    expect(createdDependency?.changeType).toBe("created");

    await simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    const updatedPage = await simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find((record) => record.sourceId === createdDependency?.sourceId);
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);

    const allChangeIds = [...initial.records, ...createdPage.records, ...updatedPage.records].map((record) => record.changeId);
    expect(new Set(allChangeIds).size).toBe(allChangeIds.length);
    expect((await simulator.feed("conn-product-manager", updatedPage.nextCursor, 100)).records).toEqual([]);
  });

  it("keeps same-pack scenario instances independent across advance, trigger, pause, reset, delete, and recreate", async () => {
    const simulator = await SourceSimulator.create({ seed: "instance-independence-seed", baseUrl: "http://sim.test" });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-a",
      seed: "instance-a-seed",
      account: "Alpha Medical",
    });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-b",
      seed: "instance-b-seed",
      account: "Beta Foods",
    });
    const bInitial = (await simulator.scenarioInstance("independent-b")).state;

    await simulator.advanceScenarioInstance("independent-a", { hours: 24 });
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).not.toBe(bInitial.currentTime);
    expect((await simulator.scenarioInstance("independent-b")).state.currentTime).toBe(bInitial.currentTime);

    await simulator.triggerScenarioInstanceEvent("independent-a", "exec-pressure");
    expect((await simulator.scenarioInstance("independent-a")).state.triggeredEventIds).toContain("exec-pressure");
    expect((await simulator.scenarioInstance("independent-b")).state.triggeredEventIds).not.toContain("exec-pressure");

    await simulator.pauseScenarioInstance("independent-a");
    const pausedA = (await simulator.scenarioInstance("independent-a")).state;
    await simulator.advanceScenarioInstance("independent-a", { hours: 12 });
    await simulator.advanceScenarioInstance("independent-b", { hours: 8 });
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).toBe(pausedA.currentTime);
    expect((await simulator.scenarioInstance("independent-b")).state.currentTime).not.toBe(bInitial.currentTime);

    const bBeforeReset = (await simulator.scenarioInstance("independent-b")).state;
    await simulator.resetScenarioInstance("independent-a", { seed: "instance-a-reset-seed" });
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).not.toBe(pausedA.currentTime);
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);

    await simulator.deleteScenarioInstance("independent-a");
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);
    await expect(simulator.scenarioInstance("independent-a")).rejects.toThrow("Unknown scenario instance");

    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-a",
      seed: "instance-a-recreated-seed",
      account: "Alpha Medical",
    });
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);
    expect((await simulator.scenarioInstance("independent-a")).state.seed).toBe("instance-a-recreated-seed");
  });

  it("keeps the ledger occurred-only and appends new creates and updates after a saved cursor", async () => {
    const simulator = await SourceSimulator.create({ seed: "occurred-ledger-seed", baseUrl: "http://sim.test" });
    const initialWorldRevision = (await simulator.datasetMetadata()).worldRevision;
    const initialChanges = await simulator.sourceChanges();
    expect(initialChanges.some((change) => change.record.title === "Workflow export API dependency")).toBe(false);
    expect(initialChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);

    const initialPage = await simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initialPage.nextCursor;
    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    expect((await simulator.datasetMetadata()).worldRevision).toBe(initialWorldRevision);

    const afterCreateChanges = await simulator.sourceChanges();
    expect(afterCreateChanges.slice(0, initialChanges.length).map((change) => change.changeId)).toEqual(
      initialChanges.map((change) => change.changeId),
    );
    expect(afterCreateChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);
    expect(new Set(afterCreateChanges.map((change) => change.changeId)).size).toBe(afterCreateChanges.length);

    const createdPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(retryCreatedPage.records.map((record) => record.changeId));
    const productStateAfterCreate = await simulator.state("product-launch-readiness");
    expect(createdPage.records.every((record) => Date.parse(record.changeOccurredAt) <= Date.parse(productStateAfterCreate.currentTime))).toBe(true);
    const createdDependency = createdPage.records.find((record) => record.title === "Workflow export API dependency");
    expect(createdDependency?.changeType).toBe("created");

    await simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    expect((await simulator.datasetMetadata()).worldRevision).toBe(initialWorldRevision);
    const updatedPage = await simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find((record) => record.sourceId === createdDependency?.sourceId);
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);
  });

  it("uses current instance time for early manual triggers and delays updates from that occurrence time", async () => {
    const simulator = await SourceSimulator.create({ seed: "manual-trigger-seed", baseUrl: "http://sim.test" });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "manual-trigger-a",
      seed: "manual-trigger-a-seed",
    });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "manual-trigger-b",
      seed: "manual-trigger-b-seed",
    });
    const beforeTrigger = (await simulator.scenarioInstance("manual-trigger-a")).state;
    const triggerTime = beforeTrigger.currentTime;
    expect(triggerTime).not.toBe(addHoursIso(beforeTrigger.startedAt, 36));

    const savedCursor = (await simulator.feed("conn-product-vp", undefined, 100)).nextCursor;
    await simulator.triggerScenarioInstanceEvent("manual-trigger-a", "exec-pressure");
    const triggered = (await simulator.scenarioInstance("manual-trigger-a")).state;
    const triggeredEvent = triggered.eventLog.find((entry) => entry.eventId === "exec-pressure");
    expect(triggered.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(triggeredEvent?.occurredAt).toBe(triggerTime);

    const triggeredPage = await simulator.feed("conn-product-vp", savedCursor, 100);
    expect(triggeredPage.records.some((record) => record.title === "Launch date question for staff" && record.changeType === "created")).toBe(true);
    expect(triggeredPage.records.some((record) => record.title === "Launch decision update" && record.changeType === "created")).toBe(true);
    expect(triggeredPage.records.some((record) => record.title === "Launch decision update" && record.changeType === "updated")).toBe(false);
    expect(
      (await simulator.sourceChanges()).some((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated"),
    ).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-a", { hours: 7 });
    expect(
      (await simulator.sourceChanges()).some((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated"),
    ).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-a", { hours: 1 });
    const updatedChange = (await simulator.sourceChanges()).find((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated");
    expect(updatedChange?.changeOccurredAt).toBe(addHoursIso(triggerTime, 8));
    expect(updatedChange?.record.updatedAt).toBe(addHoursIso(triggerTime, 8));

    const changeCountBeforeRetry = (await simulator.sourceChanges()).length;
    await simulator.triggerScenarioInstanceEvent("manual-trigger-a", "exec-pressure");
    const afterRetry = (await simulator.scenarioInstance("manual-trigger-a")).state;
    expect(afterRetry.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(afterRetry.eventLog.filter((entry) => entry.eventId === "exec-pressure")).toHaveLength(1);
    expect(await simulator.sourceChanges()).toHaveLength(changeCountBeforeRetry);

    const peer = (await simulator.scenarioInstance("manual-trigger-b")).state;
    expect(peer.triggeredEventIds).not.toContain("exec-pressure");
    expect(peer.eventOccurrenceTimes["exec-pressure"]).toBeUndefined();
    expect(peer.eventLog.some((entry) => entry.eventId === "exec-pressure")).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-b", { hours: 30 });
    const peerAfterAdvance = (await simulator.scenarioInstance("manual-trigger-b")).state;
    expect(peerAfterAdvance.eventLog.find((entry) => entry.eventId === "dependency-risk")?.occurredAt).toBe(addHoursIso(peer.startedAt, 24));
    expect(peerAfterAdvance.currentTime).toBe(addHoursIso(peer.startedAt, 30));
  });

  it("calculates manual-trigger deletions from actual trigger time", async () => {
    const simulator = await SourceSimulator.create({ seed: "manual-delete-seed", baseUrl: "http://sim.test" });
    const beforeTrigger = await simulator.state("technical-debt-staffing-risk");
    const triggerTime = beforeTrigger.currentTime;
    expect(triggerTime).not.toBe(addHoursIso(beforeTrigger.startedAt, 80));

    await simulator.triggerScenarioEvent("technical-debt-staffing-risk", "vp-investment");
    const created = (await simulator.sourceChanges()).find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "created");
    expect(created?.changeOccurredAt).toBe(triggerTime);
    expect((await simulator.sourceChanges()).some((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted")).toBe(false);

    await simulator.advanceScenario("technical-debt-staffing-risk", { hours: 35 });
    expect((await simulator.sourceChanges()).some((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted")).toBe(false);

    await simulator.advanceScenario("technical-debt-staffing-risk", { hours: 1 });
    const deleted = (await simulator.sourceChanges()).find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted");
    expect(deleted?.sourceId).toBe(created?.sourceId);
    expect(deleted?.changeOccurredAt).toBe(addHoursIso(triggerTime, 36));
    expect(deleted?.record.updatedAt).toBe(addHoursIso(triggerTime, 36));
  });

  it("filters executive-only records away from IC, Manager, and Director connections", async () => {
    const simulator = await advancedSimulator();
    const productIc = await simulator.feed("conn-product-ic", undefined, 100);
    const productManager = await simulator.feed("conn-product-manager", undefined, 100);
    const productDirector = await simulator.feed("conn-product-director", undefined, 100);
    const productVp = await simulator.feed("conn-product-vp", undefined, 100);

    expect(productIc.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productManager.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productDirector.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productVp.records.some((record) => record.title === "Launch date question for staff")).toBe(true);
  });

  it("keeps cross-department source access permission-scoped", async () => {
    const simulator = await advancedSimulator();
    const productManager = await simulator.feed("conn-product-manager", undefined, 100);
    const customerSuccessManager = await simulator.feed("conn-customer-success-manager", undefined, 100);

    expect(productManager.records.some((record) => record.title === "Workflow export API dependency")).toBe(true);
    expect(customerSuccessManager.records.some((record) => record.title === "Workflow export API dependency")).toBe(false);
  });

  it("restores snapshots exactly, including organization config", async () => {
    const simulator = await advancedSimulator();
    const before = (await simulator.allRecords()).map((record) => record.sourceId).sort();
    const snapshot = await simulator.createSnapshot();
    await simulator.regenerateOrganization({ seed: "changed-org" });
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const after = (await simulator.allRecords()).map((record) => record.sourceId).sort();

    expect(after).toEqual(before);
  });

  it("replays deterministically from a restored snapshot", async () => {
    const simulator = await SourceSimulator.create({ seed: "replay-seed" });
    await simulator.advanceScenario("reliability-incident", { hours: 5 });
    const snapshot = await simulator.createSnapshot();
    const before = (await simulator.feed("conn-engineering-manager", undefined, 100)).records.map((record) => record.sourceId);

    await simulator.advanceScenario("reliability-incident", { hours: 30 });
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const after = (await simulator.feed("conn-engineering-manager", undefined, 100)).records.map((record) => record.sourceId);

    expect(after).toEqual(before);
  });

  it("restores multiple scenario instances independently and rebuilds a deterministic ledger under a new revision", async () => {
    const simulator = await SourceSimulator.create({ seed: "snapshot-instance-seed", baseUrl: "http://sim.test" });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "snapshot-a",
      seed: "snapshot-a-seed",
      account: "Snapshot Alpha",
    });
    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "snapshot-b",
      seed: "snapshot-b-seed",
      account: "Snapshot Beta",
    });
    await simulator.advanceScenarioInstance("snapshot-a", { hours: 24 });
    await simulator.advanceScenarioInstance("snapshot-b", { hours: 8 });
    const snapshot = await simulator.createSnapshot();
    const aAtSnapshot = (await simulator.scenarioInstance("snapshot-a")).state;
    const bAtSnapshot = (await simulator.scenarioInstance("snapshot-b")).state;
    const cursorBeforeRestore = (await simulator.feed("conn-product-manager", undefined, 100)).nextCursor;
    const revisionBeforeRestore = (await simulator.datasetMetadata()).worldRevision;

    await simulator.advanceScenarioInstance("snapshot-a", { hours: 30 });
    await simulator.triggerScenarioInstanceEvent("snapshot-b", "exec-pressure");
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const firstRestoreRevision = (await simulator.datasetMetadata()).worldRevision;
    const firstRestoreLedger = (await simulator.sourceChanges()).map((change) => ({ ...change, worldRevision: "<ignored>" }));

    expect(firstRestoreRevision).not.toBe(revisionBeforeRestore);
    await expect(simulator.feed("conn-product-manager", cursorBeforeRestore, 100)).rejects.toThrow("Stale checkpoint");
    expect((await simulator.scenarioInstance("snapshot-a")).state).toEqual(aAtSnapshot);
    expect((await simulator.scenarioInstance("snapshot-b")).state).toEqual(bAtSnapshot);

    await simulator.advanceScenarioInstance("snapshot-a", { hours: 1 });
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const secondRestoreLedger = (await simulator.sourceChanges()).map((change) => ({ ...change, worldRevision: "<ignored>" }));
    expect(secondRestoreLedger).toEqual(firstRestoreLedger);
  });

  it("does not expose source updates before the simulation clock reaches the update time", async () => {
    const simulator = await SourceSimulator.create({ seed: "temporal-seed", baseUrl: "http://sim.test" });

    expect((await simulator.feed("conn-product-manager", undefined, 100)).records.some((record) => record.title === "Workflow export API dependency")).toBe(false);

    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const created = (await simulator.allRecords()).find((record) => record.title === "Workflow export API dependency");
    expect(created).toBeDefined();
    expect(created?.updatedAt).toBeUndefined();
    expect(created?.rawPayload.simulatorVersion).toBe("initial");

    await simulator.advanceScenario("product-launch-readiness", { hours: 5 });
    const beforeUpdate = (await simulator.allRecords()).find((record) => record.sourceId === created?.sourceId);
    expect(beforeUpdate?.updatedAt).toBeUndefined();

    await simulator.advanceScenario("product-launch-readiness", { hours: 1 });
    const updated = (await simulator.allRecords()).find((record) => record.sourceId === created?.sourceId);
    expect(updated?.sourceId).toBe(created?.sourceId);
    expect(updated?.updatedAt).toBe("2026-07-11T22:00:00.000Z");
    expect(updated?.rawPayload.simulatorVersion).toBe("updated");
  });

  it("emits timeline mutations as source-object versions with stable identity", async () => {
    const simulator = await SourceSimulator.create({ seed: "feed-update-seed", baseUrl: "http://sim.test" });
    await simulator.advanceScenario("reliability-incident", { hours: 5 });
    const initialPage = await simulator.feed("conn-engineering-manager", undefined, 100);
    const initial = initialPage.records.find((record) => record.title === "Throttle connector retries under queue pressure");
    expect(initial?.updatedAt).toBeUndefined();
    expect(initial?.changeType).toBe("created");

    await simulator.advanceScenario("reliability-incident", { hours: 3 });
    const afterUpdate = (await simulator.feed("conn-engineering-manager", initialPage.nextCursor, 100)).records.find((record) => record.sourceId === initial?.sourceId);
    expect(afterUpdate?.sourceId).toBe(initial?.sourceId);
    expect(afterUpdate?.updatedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(afterUpdate?.changeType).toBe("updated");
  });

  it("preserves source identity across created, updated, and deleted history entries", async () => {
    const simulator = await completedDatasetSimulator("history-seed", "small");
    const deletedChange = (await simulator.sourceChanges()).find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted");
    expect(deletedChange).toBeDefined();

    const history = await simulator.sourceObjectHistory(deletedChange!.sourceSystem, deletedChange!.sourceId);
    expect(history.map((change) => change.sourceId)).toEqual(history.map(() => deletedChange!.sourceId));
    expect(history.map((change) => change.changeType)).toEqual(["created", "deleted"]);
  });
});

describe("Milestone 2 scenario packs and adapters", () => {
  it("registers all required source adapters and validates emitted provider payloads", async () => {
    const simulator = await completedDatasetSimulator("adapter-seed", "small");
    expect(sourceAdapters.map((adapter) => adapter.sourceSystem).sort()).toEqual([...sourceSystems].sort());

    for (const adapter of sourceAdapters) {
      const change = (await simulator.sourceChanges()).find((candidate) => candidate.sourceSystem === adapter.sourceSystem);
      expect(change, adapter.sourceSystem).toBeDefined();
      expect(adapter.validatePayload(change!.record.rawPayload)).toEqual({ ok: true, errors: [] });
      expect(change!.record.rawPayload.actor).toMatchObject({ id: expect.any(String), email: expect.stringContaining("@example.test") });
      expect(adapter.buildSourceUrl({ baseUrl: "http://sim.test", sourceId: "source-123" })).toBe(
        `http://sim.test/sim/${adapter.sourceSystem}/source-123`,
      );
    }
  });

  it("covers all ten scenario packs, departments, levels, and source systems", async () => {
    const simulator = await SourceSimulator.create({ seed: "pack-seed" });
    const packs = simulator.scenarioPacks();
    const unionSources = new Set(packs.flatMap((pack) => pack.sourceSystems));
    const unionRoles = new Set(packs.flatMap((pack) => pack.participantRoleTemplateCount));

    expect(packs.map((pack) => pack.scenarioPackId)).toEqual([
      "product-launch-readiness",
      "feature-adoption-lag",
      "roadmap-tradeoff",
      "reliability-incident",
      "migration-delivery-slip",
      "technical-debt-staffing-risk",
      "renewal-risk",
      "implementation-blocker",
      "expansion-opportunity",
      "major-cross-functional-product-release",
    ]);
    expect([...unionSources].sort()).toEqual([...sourceSystems].sort());
    expect(simulator.organizationSummary().counts.byRoleLevel).toMatchObject({ ic: expect.any(Number), manager: expect.any(Number), director: expect.any(Number), vp: expect.any(Number) });
    expect([...unionRoles].length).toBeGreaterThan(0);
  });

  it("generates deterministic dataset sizes inside documented change-count ranges", async () => {
    const small = await (await completedDatasetSimulator("dataset-seed", "small")).datasetMetadata();
    const medium = await (await completedDatasetSimulator("dataset-seed", "medium")).datasetMetadata();
    const mediumReplay = await (await completedDatasetSimulator("dataset-seed", "medium")).datasetMetadata();
    const large = await (await completedDatasetSimulator("dataset-seed", "large")).datasetMetadata();

    expect(small.totalSourceChanges).toBeGreaterThanOrEqual(100);
    expect(small.totalSourceChanges).toBeLessThanOrEqual(250);
    expect(medium.totalSourceChanges).toBeGreaterThanOrEqual(1_000);
    expect(medium.totalSourceChanges).toBeLessThanOrEqual(2_500);
    expect(large.totalSourceChanges).toBeGreaterThanOrEqual(5_000);
    expect(large.totalSourceChanges).toBeLessThanOrEqual(10_000);
    expect(medium).toEqual(mediumReplay);
  });

  it("keeps cross-functional relationships explicit and separate from primary reporting", async () => {
    const simulator = await SourceSimulator.create({ seed: "relationship-seed" });
    const relationships = simulator.organizationRelationships().relationships;
    const dotted = relationships.filter((relationship) => relationship.relationshipType === "dotted_line");
    const primary = relationships.filter((relationship) => relationship.relationshipType === "primary");
    const peopleById = new Map(simulator.people().map((person) => [person.id, person]));

    expect(dotted.length).toBeGreaterThanOrEqual(2);
    for (const relationship of dotted) {
      expect(peopleById.get(relationship.reportId)?.managerId).not.toBe(relationship.managerId);
    }
    for (const person of simulator.people().filter((candidate) => candidate.managerId)) {
      expect(primary.filter((relationship) => relationship.reportId === person.id)).toHaveLength(1);
    }
    expect(simulator.teams().some((team) => team.id === "team-project-aurora" && team.level === "project")).toBe(true);
  });
});

describe("HTTP API authorization", () => {
  it("binds each connection credential to one connection ID", async () => {
    const { app } = await credentialedApp();

    const ownFeed = await app.request("/v1/connections/conn-product-manager/records", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(ownFeed.status).toBe(200);

    const otherFeed = await app.request("/v1/connections/conn-product-ic/records", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(otherFeed.status).toBe(403);
  });

  it("does not accept admin, unknown, or revoked credentials as connection credentials", async () => {
    const { app } = await credentialedApp();

    const adminAsConnection = await app.request("/v1/connections/conn-product-manager/records", {
      headers: connectionHeaders("admin-test"),
    });
    expect(adminAsConnection.status).toBe(401);

    const unknown = await app.request("/v1/connections/conn-product-manager/records", {
      headers: connectionHeaders("not-known"),
    });
    expect(unknown.status).toBe(401);

    const revoked = await app.request("/v1/connections/conn-product-manager/records", {
      headers: connectionHeaders("revoked-connection"),
    });
    expect(revoked.status).toBe(401);
  });

  it("requires admin auth for detailed catalog and visibility routes", async () => {
    const { app } = await credentialedApp();
    const publicCatalog = await app.request("/v1/catalog");
    expect(publicCatalog.status).toBe(200);
    expect(await publicCatalog.json()).not.toHaveProperty("people");

    expect((await app.request("/v1/catalog/people")).status).toBe(401);
    expect((await app.request("/v1/catalog/organization/tree")).status).toBe(401);
    expect((await app.request("/v1/catalog/teams")).status).toBe(401);
    expect((await app.request("/v1/admin/people/missing/records")).status).toBe(401);

    const people = await app.request("/v1/catalog/people", { headers: adminHeaders() });
    expect(people.status).toBe(200);
    expect((await people.json()).people.length).toBeGreaterThan(0);
  });

  it("rejects memory and SQLite storage in production-like runtimes, including injected options", async () => {
    const productionCredentials = { "prod-product-manager": "conn-product-manager" };
    await expect(
      withEnv(
        { SIMULATOR_STORAGE_DRIVER: "sqlite", SIMULATOR_ALLOW_EPHEMERAL_MEMORY: undefined, DATABASE_URL: undefined },
        () => createApp({ runtimeEnv: "preview", adminKey: "prod-admin", connectionCredentials: productionCredentials }),
      ),
    ).rejects.toThrow(/SQLite storage is forbidden/);
    await expect(
      withEnv(
        { SIMULATOR_STORAGE_DRIVER: "memory", SIMULATOR_ALLOW_EPHEMERAL_MEMORY: "true", DATABASE_URL: undefined },
        () => createApp({ runtimeEnv: "production", adminKey: "prod-admin", connectionCredentials: productionCredentials }),
      ),
    ).rejects.toThrow(/memory storage.*forbidden/i);
    await expect(
      createApp({
        storage: new MemorySimulatorStorage(),
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: productionCredentials,
      }),
    ).rejects.toThrow(/Injected storage uses memory storage/);

    const sqlitePath = join(mkdtempSync(join(tmpdir(), "source-sim-prod-")), "simulator.sqlite");
    const sqliteStorage = new SQLiteSimulatorStorage(sqlitePath);
    try {
      await expect(
        createApp({
          storage: sqliteStorage,
          runtimeEnv: "production",
          adminKey: "prod-admin",
          connectionCredentials: productionCredentials,
        }),
      ).rejects.toThrow(/Injected storage uses SQLite storage/);
    } finally {
      await sqliteStorage.close();
    }

    const injectedSimulator = await SourceSimulator.create({ storage: new MemorySimulatorStorage() });
    await expect(
      createApp({
        simulator: injectedSimulator,
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: productionCredentials,
      }),
    ).rejects.toThrow(/Injected simulator storage uses memory storage/);
  });

  it("keeps connection authentication consistent after organization regeneration", async () => {
    const simulator = await SourceSimulator.create({ seed: "regen-auth-seed", baseUrl: "http://sim.test" });
    const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
    const removedPerson = simulator.people().find((person) => person.stableKey === "product:ic:v1:d1:m1:i4");
    expect(removedPerson).toBeDefined();
    const removedConnectionId = personConnectionId(removedPerson!);

    const before = await app.request(`/v1/connections/${removedConnectionId}/manifest`, {
      headers: developmentConnectionHeaders(removedConnectionId),
    });
    expect(before.status).toBe(200);

    const nextConfig = cloneDefaultOrganizationConfig();
    nextConfig.seed = "regen-auth-new-seed";
    nextConfig.departments.product = { vpCount: 1, directorsPerVp: 1, managersPerDirector: 1, icsPerManager: 1 };
    const regenerated = await app.request("/v1/admin/organization/generate", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ config: nextConfig }),
    });
    expect(regenerated.status).toBe(200);

    const oldCredential = await app.request(`/v1/connections/${removedConnectionId}/manifest`, {
      headers: developmentConnectionHeaders(removedConnectionId),
    });
    expect(oldCredential.status).toBe(401);

    for (const person of simulator.people()) {
      const connectionId = personConnectionId(person);
      const response = await app.request(`/v1/connections/${connectionId}/manifest`, {
        headers: developmentConnectionHeaders(connectionId),
      });
      expect(response.status).toBe(200);
    }

    const roleAlias = await app.request("/v1/connections/conn-product-ic/manifest", {
      headers: developmentConnectionHeaders("conn-product-ic"),
    });
    expect(roleAlias.status).toBe(200);
    expect((await roleAlias.json()).connectionId).toBe("conn-product-ic");

    const publicCatalog = await app.request("/v1/catalog");
    expect(JSON.stringify(await publicCatalog.json())).not.toContain("dev-connection-secret");
  });
});

describe("HTTP API validation", () => {
  it("returns 400 for malformed JSON instead of treating it as empty", async () => {
    const { app } = await credentialedApp();
    const response = await app.request("/v1/admin/scenarios/product-launch-readiness/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
  });

  it("enforces organization and pagination bounds", async () => {
    const { app } = await credentialedApp();
    const tooLargeOrg = await app.request("/v1/admin/organization/generate", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          seed: "oversized",
          departments: {
            product: { vpCount: 3, directorsPerVp: 8, managersPerDirector: 10, icsPerManager: 25 },
            engineering: { vpCount: 3, directorsPerVp: 8, managersPerDirector: 10, icsPerManager: 25 },
            customer_success: { vpCount: 3, directorsPerVp: 8, managersPerDirector: 10, icsPerManager: 25 },
          },
        },
      }),
    });
    expect(tooLargeOrg.status).toBe(400);

    const tooLargePage = await app.request("/v1/connections/conn-product-manager/records?limit=1000", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(tooLargePage.status).toBe(400);
  });

  it("rejects organization configs that leave enabled scenarios without required roles", async () => {
    const { app } = await credentialedApp();
    const requestConfig = (config: ReturnType<typeof cloneDefaultOrganizationConfig>) =>
      app.request("/v1/admin/organization/generate", {
        method: "POST",
        headers: { ...adminHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ config }),
      });
    let incompatibleIndex = 0;
    const incompatible = async (mutate: (config: ReturnType<typeof cloneDefaultOrganizationConfig>) => void) => {
      const config = cloneDefaultOrganizationConfig();
      config.seed = `incompatible-${incompatibleIndex++}`;
      mutate(config);
      const response = await requestConfig(config);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/incompatible with enabled scenarios|missing required role/);
    };

    await incompatible((config) => {
      config.departments.product.vpCount = 0;
    });
    await incompatible((config) => {
      config.departments.product.directorsPerVp = 0;
    });
    await incompatible((config) => {
      config.departments.product.managersPerDirector = 0;
    });
    await incompatible((config) => {
      config.departments.product.icsPerManager = 0;
      config.departments.product.customIcsPerManager = {};
    });
    await incompatible((config) => {
      config.departments.product.customIcsPerManager = {
        "product:v1:d1:m1": 0,
        "product:v1:d1:m2": 0,
        "product:v1:d2:m1": 0,
        "product:v1:d2:m2": 0,
      };
    });
  });

  it("fails closed on cursor tampering and cross-connection cursors", async () => {
    const { app } = await credentialedApp();
    const badCursor = await app.request("/v1/connections/conn-product-manager/records?cursor=not-base64", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(badCursor.status).toBe(400);

    const first = await app.request("/v1/connections/conn-product-manager/records?limit=1", {
      headers: connectionHeaders("secret-product-manager"),
    });
    const firstBody = await first.json();
    const crossed = await app.request(`/v1/connections/conn-product-ic/records?cursor=${encodeURIComponent(firstBody.nextCursor)}`, {
      headers: connectionHeaders("secret-product-ic"),
    });
    expect(crossed.status).toBe(400);
  });

  it("honors bounded request bodies", async () => {
    const { app } = await credentialedApp();
    const response = await app.request("/v1/admin/scenarios/product-launch-readiness/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ hours: 24 * 31 }),
    });
    expect(response.status).toBe(400);
  });
});

describe("source deep links", () => {
  it("resolves every emitted source URL for the authenticated connection", async () => {
    const { app } = await credentialedApp();
    const feed = await app.request("/v1/connections/conn-product-manager/records?limit=10", {
      headers: connectionHeaders("secret-product-manager"),
    });
    const body = await feed.json();
    const record = SourceFeedBatchV1Schema.parse(body).records[0]!;
    const link = new URL(record.sourceUrl);

    const resolved = await app.request(link.pathname, { headers: connectionHeaders("secret-product-manager") });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).record.sourceId).toBe(record.sourceId);
  });

  it("fails safely for unknown and unauthorized source objects", async () => {
    const { app } = await credentialedApp();
    const vpFeed = await app.request("/v1/connections/conn-product-vp/records?limit=100", {
      headers: connectionHeaders("secret-product-vp"),
    });
    const execRecord = SourceFeedBatchV1Schema.parse(await vpFeed.json()).records.find((record) => record.title === "Launch date question for staff")!;
    const execLink = new URL(execRecord.sourceUrl);

    const unauthorized = await app.request(execLink.pathname, { headers: connectionHeaders("secret-product-ic") });
    expect(unauthorized.status).toBe(403);

    const unknown = await app.request("/sim/slack/not-real", { headers: connectionHeaders("secret-product-manager") });
    expect(unknown.status).toBe(404);
  });
});

describe("Milestone 3 operations", () => {
  it("exposes production health, metrics, request inspection, and storage inspection", async () => {
    const { app } = await credentialedApp();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      schemaVersion: "simulator-liveness.v1",
      contractVersion: "source-feed.v1",
    });

    const readiness = await app.request("/readyz");
    expect(readiness.status).toBe(200);
    const readinessBody = await readiness.json();
    expect(readinessBody).toMatchObject({
      ok: true,
      schemaVersion: "simulator-readiness.v1",
      storage: { kind: "memory", ok: true },
    });
    expect(readinessBody.worldRevision).toMatch(/^world-/);

    await app.request("/v1/connections/conn-product-manager/records?limit=2", {
      headers: connectionHeaders("secret-product-manager"),
    });
    const metrics = await app.request("/v1/admin/metrics", { headers: adminHeaders() });
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.json();
    expect(metricsBody.schemaVersion).toBe("simulator-metrics.v1");
    expect(metricsBody.requests.total).toBeGreaterThan(0);
    expect(metricsBody.simulator.sourceChanges).toBeGreaterThan(0);
    expect(metricsBody.simulator.worldRevision).toBe(readinessBody.worldRevision);

    const requests = await app.request("/v1/admin/requests", { headers: adminHeaders() });
    expect((await requests.json()).requests.some((request: { connectionId?: string }) => request.connectionId === "conn-product-manager")).toBe(true);

    const storage = await app.request("/v1/admin/storage", { headers: adminHeaders() });
    expect((await storage.json()).counts.sourceChanges).toBeGreaterThan(0);
  });

  it("enforces real request rate limits separately from simulated provider failures", async () => {
    const simulator = await advancedSimulator("rate-limit-seed");
    const app = await createApp({
      simulator,
      runtimeEnv: "test",
      adminKey: "admin-test",
      connectionCredentials: { "secret-product-manager": "conn-product-manager" },
      rateLimitConfigJson: JSON.stringify({ enabled: true, windowMs: 60_000, adminLimit: 1, connectionLimit: 1 }),
    });

    expect((await app.request("/v1/connections/conn-product-manager/manifest", { headers: connectionHeaders("secret-product-manager") })).status).toBe(200);
    const limitedConnection = await app.request("/v1/connections/conn-product-manager/records", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(limitedConnection.status).toBe(429);
    expect(limitedConnection.headers.get("Retry-After")).toEqual(expect.any(String));
    expect((await limitedConnection.json()).classification).toBe("rate_limit");

    expect((await app.request("/v1/admin/requests", { headers: adminHeaders() })).status).toBe(200);
    const limitedAdmin = await app.request("/v1/admin/metrics", { headers: adminHeaders() });
    expect(limitedAdmin.status).toBe(429);
  });

  it("rejects Postgres benchmarks that reuse the application database URL", () => {
    expect(() => assertBenchmarkDatabaseIsIsolated("postgres://user:pass@localhost:5432/app?sslmode=disable", "postgres://user:pass@localhost:5432/app?sslmode=disable")).toThrow(
      /separate from DATABASE_URL/,
    );
    expect(() => assertBenchmarkDatabaseIsIsolated("postgres://user:pass@localhost:5432/app", "postgres://user:pass@localhost:5432/benchmark")).not.toThrow();
  });

  it("persists manual and realtime company clock semantics across SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-sim-clock-"));
    const databasePath = join(directory, "clock.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({
      storage,
      now: "2026-07-10T00:00:00.000Z",
      clockMode: "manual",
      baseUrl: "http://sim.test",
    });
    const stateBefore = await simulator.state("product-launch-readiness");
    const manualReport = await simulator.reconcileSimulationClock({ now: "2026-07-10T01:00:00.000Z" });
    expect(manualReport.simulationDeltaMs).toBe(0);
    expect((await simulator.state("product-launch-readiness")).currentTime).toBe(stateBefore.currentTime);

    await simulator.updateClock({ mode: "realtime", speedMultiplier: 60 }, "2026-07-10T01:00:00.000Z");
    const realtimeReport = await simulator.reconcileSimulationClock({ now: "2026-07-10T01:01:00.000Z" });
    expect(realtimeReport.simulationDeltaMs).toBe(60 * 60 * 1000);
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe("2026-07-10T01:00:00.000Z");

    await simulator.pauseClock("2026-07-10T01:01:00.000Z");
    const pausedReport = await simulator.reconcileSimulationClock({ now: "2026-07-10T01:05:00.000Z" });
    expect(pausedReport.simulationDeltaMs).toBe(0);
    await simulator.resumeClock("2026-07-10T01:05:00.000Z");
    const resumedReport = await simulator.reconcileSimulationClock({ now: "2026-07-10T01:06:00.000Z" });
    expect(resumedReport.simulationDeltaMs).toBe(60 * 60 * 1000);
    await simulator.close();

    const restarted = await SourceSimulator.create({ storage: new SQLiteSimulatorStorage(databasePath), baseUrl: "http://sim.test" });
    expect((await restarted.clockStatus()).clock.lastReconciledSimulationTime).toBe("2026-07-10T02:00:00.000Z");
    await restarted.close();
  });

  it("reconciles realtime clock before serving a saved connection cursor", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const simulator = await SourceSimulator.create({
      seed: "feed-clock-seed",
      now: oneMinuteAgo,
      clockMode: "realtime",
      clockSpeedMultiplier: 1440,
      baseUrl: "http://sim.test",
    });
    const initial = await simulator.feed("conn-product-manager", undefined, 100);
    const app = await createApp({
      simulator,
      runtimeEnv: "test",
      adminKey: "admin-test",
      connectionCredentials: { "secret-product-manager": "conn-product-manager" },
    });
    const incremental = await app.request(`/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(initial.nextCursor)}`, {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(incremental.status).toBe(200);
    const body = SourceFeedBatchV1Schema.parse(await incremental.json());
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.some((record) => record.correlation.eventId !== "baseline")).toBe(true);
    expect((await simulator.clockStatus()).clock.reconciliationCount).toBeGreaterThan(0);
  });

  it("creates deterministic continuous successors idempotently in one shared company world", async () => {
    const simulator = await SourceSimulator.create({
      seed: "continuous-seed",
      now: "2026-07-10T00:00:00.000Z",
      clockMode: "realtime",
      clockSpeedMultiplier: 1440,
      continuousActivity: true,
      maxSuccessorInstancesPerReconciliation: 20,
      baseUrl: "http://sim.test",
    });
    await simulator.generateDataset({ seed: "continuous-seed", datasetSize: "small", startTime: "2026-07-01T00:00:00.000Z" });
    await simulator.updateClock({ mode: "realtime", continuousActivity: true, speedMultiplier: 1440 }, "2026-07-10T00:00:00.000Z");
    const first = await simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" });
    expect(first.instancesCreated).toBe(10);
    const statesAfterFirst = await simulator.states();
    expect(new Set(statesAfterFirst.map((state) => state.scenarioInstanceId)).size).toBe(statesAfterFirst.length);
    expect(statesAfterFirst.some((state) => state.scenarioInstanceId.startsWith("major-cross-functional-product-release-continuous-"))).toBe(true);

    const repeated = await simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" });
    expect(repeated.instancesCreated).toBe(0);
    expect(await simulator.states()).toHaveLength(statesAfterFirst.length);

    await simulator.reconcileSimulationClock({ now: "2026-07-10T00:06:00.000Z" });
    const majorSuccessor = (await simulator.states()).find((state) => state.scenarioInstanceId.startsWith("major-cross-functional-product-release-continuous-"))!;
    const majorSources = new Set((await simulator.sourceChanges()).filter((change) => change.scenarioInstanceId === majorSuccessor.scenarioInstanceId).map((change) => change.sourceSystem));
    expect([...sourceSystems].every((source) => majorSources.has(source))).toBe(true);
    expect(new Set((await simulator.sourceChanges()).map((change) => change.changeId)).size).toBe((await simulator.sourceChanges()).length);
  });

  it("rolls back failed realtime reconciliation without advancing clock or ledger", async () => {
    const storage = new SQLiteSimulatorStorage(":memory:");
    const simulator = await SourceSimulator.create({
      storage,
      seed: "reconcile-rollback",
      now: "2026-07-10T00:00:00.000Z",
      clockMode: "realtime",
      clockSpeedMultiplier: 60,
      baseUrl: "http://sim.test",
    });
    const before = await storageWorldSnapshot(simulator);
    const clockBefore = (await simulator.clockStatus()).clock;
    storage.injectWorldReplacementFailureForTesting();
    await expect(simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" })).rejects.toThrow("Injected world replacement failure");
    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    expect((await simulator.clockStatus()).clock).toEqual(clockBefore);
    await simulator.close();
  });

  it("authorizes Vercel cron ticks and rejects missing or incorrect cron secrets", async () => {
    const simulator = await SourceSimulator.create({ seed: "cron-seed" });
    await withEnv({ CRON_SECRET: "cron-secret" }, async () => {
      const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
      expect((await app.request("/api/cron/tick")).status).toBe(401);
      expect((await app.request("/api/cron/tick", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
      const ok = await app.request("/api/cron/tick", { headers: { Authorization: "Bearer cron-secret" } });
      expect(ok.status).toBe(200);
      expect((await ok.json()).schemaVersion).toBe("simulation-cron-tick.v1");
    });
    await withEnv({ CRON_SECRET: undefined }, async () => {
      const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
      const missing = await app.request("/api/cron/tick", { headers: { Authorization: "Bearer cron-secret" } });
      expect(missing.status).toBe(503);
      expect((await missing.json()).classification).toBe("configuration_error");
    });
  });

  it("refreshes stale warm-process organization state before connection authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-sim-refresh-"));
    const databasePath = join(directory, "refresh.sqlite");
    const simulatorA = await SourceSimulator.create({ storage: new SQLiteSimulatorStorage(databasePath), seed: "warm-a", baseUrl: "http://sim.test" });
    const simulatorB = await SourceSimulator.create({ storage: new SQLiteSimulatorStorage(databasePath), seed: "warm-b", baseUrl: "http://sim.test" });
    const appA = await createApp({ simulator: simulatorA, runtimeEnv: "test", adminKey: "admin-test" });
    const appB = await createApp({ simulator: simulatorB, runtimeEnv: "test", adminKey: "admin-test" });
    const oldProductIcs = simulatorB.people().filter((person) => person.roleTemplateId === "role-product-ic");
    const oldPersonConnection = personConnectionId(oldProductIcs[oldProductIcs.length - 1]!);
    const nextConfig = cloneDefaultOrganizationConfig();
    nextConfig.seed = "warm-new-org-seed";
    nextConfig.departments.product = {
      ...nextConfig.departments.product,
      vpCount: 1,
      directorsPerVp: 1,
      managersPerDirector: 1,
      icsPerManager: 1,
      customDirectorsPerVp: {},
      customManagersPerDirector: {},
      customIcsPerManager: {},
    };

    const regenerated = await appA.request("/v1/admin/organization/generate", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ config: nextConfig }),
    });
    expect(regenerated.status).toBe(200);

    const oldConnection = await appB.request(`/v1/connections/${oldPersonConnection}/manifest`, {
      headers: developmentConnectionHeaders(oldPersonConnection),
    });
    expect(oldConnection.status).toBe(401);
    const roleAlias = await appB.request("/v1/connections/conn-product-manager/manifest", {
      headers: developmentConnectionHeaders("conn-product-manager"),
    });
    expect(roleAlias.status).toBe(200);
    await simulatorA.close();
    await simulatorB.close();
  });

  it("validates Vercel deployment config and standard route surface", async () => {
    const config = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
    expect(config.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(config.functions["api/index.ts"]).toMatchObject({ runtime: "nodejs22.x", maxDuration: 30 });
    expect(config.crons).toContainEqual({ path: "/api/cron/tick", schedule: "*/5 * * * *" });
    expect(config.rewrites).toContainEqual({ source: "/(.*)", destination: "/api/index" });

    const { app } = await credentialedApp();
    expect((await app.request("/")).status).toBe(302);
    expect((await app.request("/console")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/v1/catalog")).status).toBe(200);
  });

  it("serializes concurrent source-world mutations without skipping or duplicating ledger entries", async () => {
    const simulator = await SourceSimulator.create({ seed: "concurrency-seed", baseUrl: "http://sim.test" });
    const before = await simulator.sourceChanges();
    await Promise.all([
      simulator.advanceScenarioInstance("product-launch-readiness-default", { hours: 24 }),
      simulator.advanceScenarioInstance("reliability-incident-default", { hours: 5 }),
      simulator.createScenarioInstance({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "concurrent-created",
        seed: "concurrent-created-seed",
      }),
    ]);
    const after = await simulator.sourceChanges();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);
    expect(new Set(after.map((change) => change.changeId)).size).toBe(after.length);
  });

  it("exercises connector lifecycle over real HTTP routes", async () => {
    const simulator = await SourceSimulator.create({ seed: "http-connector-kit-seed", baseUrl: "http://sim.test" });
    const app = await createApp({
      simulator,
      runtimeEnv: "test",
      adminKey: "admin-test",
      connectionCredentials: {
        "secret-product-manager": "conn-product-manager",
        "secret-product-vp": "conn-product-vp",
        "secret-product-ic": "conn-product-ic",
      },
      revokedConnectionCredentials: ["revoked-connection"],
    });

    const initial = SourceFeedBatchV1Schema.parse(
      await (
        await app.request("/v1/connections/conn-product-manager/records?limit=25", {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).json(),
    );
    const savedCursor = initial.nextCursor;

    const created = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "http-kit-instance",
        seed: "http-kit-instance-seed",
      }),
    });
    expect(created.status).toBe(200);
    await app.request("/v1/admin/scenario-instances/http-kit-instance/trigger", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "exec-pressure" }),
    });
    const incremental = SourceFeedBatchV1Schema.parse(
      await (
        await app.request(`/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(savedCursor)}`, {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).json(),
    );
    expect(incremental.records.some((record) => record.correlation.scenarioId === "product-launch-readiness")).toBe(true);

    await app.request("/v1/admin/scenario-instances/http-kit-instance/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ hours: 48 }),
    });
    const updates = SourceFeedBatchV1Schema.parse(
      await (
        await app.request(`/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(incremental.nextCursor)}`, {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).json(),
    );
    expect(updates.records.some((record) => record.changeType === "updated" || record.changeType === "deleted")).toBe(true);

    const staleCursor = updates.nextCursor;
    await app.request("/v1/admin/scenario-instances/http-kit-instance/reset", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    const stale = await app.request(`/v1/connections/conn-product-manager/records?cursor=${encodeURIComponent(staleCursor)}`, {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(stale.status).toBe(400);
    expect((await stale.json()).classification).toBe("stale_cursor");

    expect((await app.request("/v1/connections/conn-product-manager/records", { headers: connectionHeaders("not-known") })).status).toBe(401);
    expect((await app.request("/v1/connections/conn-product-manager/records", { headers: connectionHeaders("revoked-connection") })).status).toBe(401);
    const icPage = SourceFeedBatchV1Schema.parse(
      await (await app.request("/v1/connections/conn-product-ic/records?limit=100", { headers: connectionHeaders("secret-product-ic") })).json(),
    );
    expect(icPage.records.length).not.toBe(initial.records.length);

    await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [{ id: "sim-429", enabled: true, mode: "rate_limit", operation: "feed", connectionId: "conn-product-manager" }],
      }),
    });
    expect(
      (
        await app.request("/v1/connections/conn-product-manager/records", {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).status,
    ).toBe(429);
    await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [{ id: "sim-503", enabled: true, mode: "service_unavailable", operation: "manifest", connectionId: "conn-product-manager" }],
      }),
    });
    expect(
      (
        await app.request("/v1/connections/conn-product-manager/manifest", {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).status,
    ).toBe(503);
  });

  it("applies deterministic failure modes without random behavior", async () => {
    const { app } = await credentialedApp();
    const configured = await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [
          { id: "partial", enabled: true, mode: "partial_page", operation: "feed", connectionId: "conn-product-manager", pageSize: 1 },
          { id: "duplicate", enabled: true, mode: "duplicate_objects", operation: "feed", connectionId: "conn-product-manager" },
          { id: "edited", enabled: true, mode: "edited_objects", operation: "feed", connectionId: "conn-product-manager" },
        ],
      }),
    });
    expect(configured.status).toBe(200);

    const feed = await app.request("/v1/connections/conn-product-manager/records?limit=10", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(feed.status).toBe(200);
    const body = SourceFeedBatchV1Schema.parse(await feed.json());
    expect(body.records).toHaveLength(2);
    expect(body.records[0]!.sourceId).toBe(body.records[1]!.sourceId);
    expect(body.records[0]!.title).toContain("simulated edit");

    await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [{ id: "auth", enabled: true, mode: "auth_failure", operation: "manifest", connectionId: "conn-product-manager" }],
      }),
    });
    const authFailure = await app.request("/v1/connections/conn-product-manager/manifest", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(authFailure.status).toBe(401);
    expect((await authFailure.json()).classification).toBe("auth_failure");

    await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [{ id: "cursor", enabled: true, mode: "cursor_corruption", operation: "feed", connectionId: "conn-product-manager" }],
      }),
    });
    const corrupted = await app.request("/v1/connections/conn-product-manager/records?limit=1", {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect((await corrupted.json()).nextCursor).toBe("corrupted-cursor-for-failure-test");

    const reset = await app.request("/v1/admin/failure-modes/reset", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect((await reset.json()).rules).toHaveLength(0);
  });

  it("runs the connector lifecycle kit and a bounded performance benchmark", async () => {
    const { app } = await credentialedApp();
    const kit = await app.request("/v1/admin/connector-test-kit/run", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect(kit.status).toBe(200);
    const kitBody = await kit.json();
    expect(kitBody.schemaVersion).toBe("connector-test-kit.v1");
    expect(kitBody.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);

    const benchmark = await app.request("/v1/admin/performance/benchmark", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ storage: "memory", seed: "test-benchmark", datasetSizes: ["small"] }),
    });
    expect(benchmark.status).toBe(200);
    const benchmarkBody = await benchmark.json();
    expect(benchmarkBody.schemaVersion).toBe("simulator-performance-benchmark.v1");
    expect(benchmarkBody.results[0].operations.generate.durationMs).toBeGreaterThanOrEqual(0);
    expect(benchmarkBody.results[0].counts.sourceChanges).toBeGreaterThan(0);
  });
});

describe("Milestone 2 admin APIs", () => {
  it("exposes scenario packs, instances, dataset metadata, and source history through admin routes", async () => {
    const { app } = await credentialedApp(completedDatasetSimulator("api-m2-seed", "medium"));

    const packs = await app.request("/v1/catalog/scenario-packs");
    expect(packs.status).toBe(200);
    expect((await packs.json()).scenarioPacks).toHaveLength(10);

    const instances = await app.request("/v1/catalog/scenario-instances", { headers: adminHeaders() });
    const instanceBody = await instances.json();
    expect(instanceBody.scenarioInstances).toHaveLength(80);

    const dataset = await app.request("/v1/admin/datasets/current", { headers: adminHeaders() });
    expect((await dataset.json()).totalSourceChanges).toBeGreaterThanOrEqual(1_000);

    const sourceObjects = await app.request("/v1/admin/source-objects", { headers: adminHeaders() });
    const object = (await sourceObjects.json()).sourceObjects[0];
    const history = await app.request(`/v1/admin/source-objects/${object.sourceSystem}/${object.sourceId}/history`, { headers: adminHeaders() });
    expect((await history.json()).history[0].sourceId).toBe(object.sourceId);
  });

  it("creates real independent scenario instances through POST and validates duplicate and unknown packs", async () => {
    const { app, simulator } = await credentialedApp(await SourceSimulator.create({ seed: "api-create-seed", baseUrl: "http://sim.test" }));
    const created = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "api-created-instance",
        seed: "api-created-seed",
        account: "Created Account",
      }),
    });
    expect(created.status).toBe(200);
    expect((await created.json()).state).toMatchObject({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "api-created-instance",
      seed: "api-created-seed",
      account: "Created Account",
    });
    expect((await simulator.scenarioInstance("api-created-instance")).state.seed).toBe("api-created-seed");

    const duplicate = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ scenarioPackId: "product-launch-readiness", scenarioInstanceId: "api-created-instance" }),
    });
    expect(duplicate.status).toBe(400);

    const unknown = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ scenarioPackId: "not-a-pack", scenarioInstanceId: "missing-pack-instance" }),
    });
    expect(unknown.status).toBe(400);
  });

  it("persists POST-created scenario instances across SQLite restart", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-instance-api-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const firstSimulator = await SourceSimulator.create({ seed: "sqlite-instance-create", storage: firstStorage, baseUrl: "http://sim.test" });
    const { app } = await credentialedApp(firstSimulator);
    const created = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        scenarioPackId: "reliability-incident",
        scenarioInstanceId: "sqlite-created-instance",
        seed: "sqlite-created-seed",
        service: "connector-gateway",
      }),
    });
    expect(created.status).toBe(200);
    firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const secondSimulator = await SourceSimulator.create({ seed: "ignored-seed", storage: secondStorage, baseUrl: "http://sim.test" });
    expect((await secondSimulator.scenarioInstance("sqlite-created-instance")).state).toMatchObject({
      scenarioPackId: "reliability-incident",
      seed: "sqlite-created-seed",
      service: "connector-gateway",
    });
    secondStorage.close();
  });

  it("does not expose future changes through the admin source-change route", async () => {
    const { app } = await credentialedApp(await SourceSimulator.create({ seed: "api-ledger-seed", baseUrl: "http://sim.test" }));
    const initial = await app.request("/v1/admin/source-changes", { headers: adminHeaders() });
    expect((await initial.json()).sourceChanges.some((change: { record: { title: string } }) => change.record.title === "Workflow export API dependency")).toBe(
      false,
    );

    await app.request("/v1/admin/scenarios/product-launch-readiness/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ hours: 24 }),
    });
    const advanced = await app.request("/v1/admin/source-changes", { headers: adminHeaders() });
    expect((await advanced.json()).sourceChanges.some((change: { record: { title: string } }) => change.record.title === "Workflow export API dependency")).toBe(
      true,
    );
  });

  it("generates and resets datasets through bounded admin endpoints", async () => {
    const { app } = await credentialedApp();
    const generated = await app.request("/v1/admin/datasets/generate", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ seed: "dataset-api-seed", datasetSize: "large" }),
    });
    expect(generated.status).toBe(200);
    expect((await generated.json()).totalSourceChanges).toBeGreaterThanOrEqual(5_000);

    const reset = await app.request("/v1/admin/datasets/reset", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect(reset.status).toBe(200);
    expect((await reset.json()).datasetSize).toBe("small");
  });
});

describe("SQLite storage", () => {
  it("keeps the migration schema aligned with the runtime SQLite schema", async () => {
    const migrationSql = await readFile(new URL("../../migrations/001_initial.sql", import.meta.url), "utf8");
    const runtimeDatabasePath = join(mkdtempSync(join(tmpdir(), "source-sim-runtime-schema-")), "runtime.sqlite");
    const runtimeStorage = new SQLiteSimulatorStorage(runtimeDatabasePath);
    runtimeStorage.close();

    const migrationDatabase = openTestSQLiteDatabase(":memory:");
    const runtimeDatabase = openTestSQLiteDatabase(runtimeDatabasePath);
    try {
      migrationDatabase.exec(migrationSql);
      const expectedSchema = {
        dataset_metadata: "CREATE TABLE dataset_metadata ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), metadata_json TEXT NOT NULL )",
        organization_config: "CREATE TABLE organization_config ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), config_json TEXT NOT NULL )",
        scenario_instance_states: "CREATE TABLE scenario_instance_states ( scenario_instance_id TEXT PRIMARY KEY, scenario_pack_id TEXT NOT NULL, state_json TEXT NOT NULL )",
        scenario_states: "CREATE TABLE scenario_states ( scenario_id TEXT PRIMARY KEY, state_json TEXT NOT NULL )",
        continuous_orchestration_state: "CREATE TABLE continuous_orchestration_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL )",
        simulation_clock_state: "CREATE TABLE simulation_clock_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL )",
        source_change_ledger: "CREATE TABLE source_change_ledger ( ledger_sequence INTEGER PRIMARY KEY, world_revision TEXT NOT NULL, change_json TEXT NOT NULL )",
        source_objects: "CREATE TABLE source_objects ( source_key TEXT PRIMARY KEY, world_revision TEXT NOT NULL, object_json TEXT NOT NULL )",
        snapshots: "CREATE TABLE snapshots ( snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL )",
        world_state: "CREATE TABLE world_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), world_revision TEXT NOT NULL )",
      };
      const normalizedExpectedSchema = Object.fromEntries(Object.entries(expectedSchema).map(([name, sql]) => [name, normalizeSql(sql)]));
      expect(durableTableSql(migrationDatabase)).toEqual(normalizedExpectedSchema);
      expect(durableTableSql(runtimeDatabase)).toEqual(normalizedExpectedSchema);
    } finally {
      migrationDatabase.close();
      runtimeDatabase.close();
    }
  });

  it("rolls back failed world replacement during scenario instance creation", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-create-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({ seed: "atomic-create-seed", storage, baseUrl: "http://sim.test" });
    const before = await storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    await expect(
      simulator.createScenarioInstance({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "should-roll-back",
        seed: "should-roll-back-seed",
      }),
    ).rejects.toThrow("Injected world replacement failure");

    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    await expect(simulator.scenarioInstance("should-roll-back")).rejects.toThrow("Unknown scenario instance");
    await storage.close();
  });

  it("rolls back failed world replacement during scenario instance reset", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-reset-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({ seed: "atomic-reset-seed", storage, baseUrl: "http://sim.test" });
    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const before = await storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    await expect(simulator.resetScenarioInstance("product-launch-readiness-default", { seed: "failed-reset-seed" })).rejects.toThrow("Injected world replacement failure");

    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    await storage.close();
  });

  it("rolls back failed world replacement during dataset generation", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-dataset-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({ seed: "atomic-dataset-seed", storage, baseUrl: "http://sim.test" });
    const before = await storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    await expect(simulator.generateDataset({ seed: "failed-dataset-seed", datasetSize: "medium" })).rejects.toThrow("Injected world replacement failure");

    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    await storage.close();
  });

  it("persists scenario states, organization config, and snapshots across engine recreation", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = await SourceSimulator.create({ seed: "sqlite-seed", storage: firstStorage });
    await first.advanceScenario("product-launch-readiness", { hours: 24 });
    await first.regenerateOrganization({ seed: "sqlite-org-seed" });
    const snapshot = await first.createSnapshot();
    const stateBefore = await first.state("product-launch-readiness");
    const metadataBefore = await first.datasetMetadata();
    const firstCursor = (await first.feed("conn-product-manager", undefined, 10)).nextCursor;
    await firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = await SourceSimulator.create({ seed: "other-seed", storage: secondStorage });
    expect((await second.state("product-launch-readiness")).currentTime).toBe(stateBefore.currentTime);
    expect(second.organizationSummary().seed).toBe("sqlite-org-seed");
    expect((await second.listSnapshots()).map((candidate) => candidate.snapshotId)).toContain(snapshot.snapshotId);
    expect(await second.datasetMetadata()).toEqual(metadataBefore);
    expect((await second.feed("conn-product-manager", firstCursor, 10)).worldRevision).toBe(metadataBefore.worldRevision);
    expect((await second.sourceChanges()).length).toBe(metadataBefore.totalSourceChanges);
    await secondStorage.close();
  });

  it("persists manual trigger occurrence time across engine recreation", async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-manual-trigger-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = await SourceSimulator.create({ seed: "sqlite-manual-trigger-seed", storage: firstStorage, baseUrl: "http://sim.test" });
    const triggerTime = (await first.state("product-launch-readiness")).currentTime;
    await first.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
    const beforeRestart = await first.state("product-launch-readiness");
    expect(beforeRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    await firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = await SourceSimulator.create({ seed: "ignored-seed", storage: secondStorage, baseUrl: "http://sim.test" });
    const afterRestart = await second.state("product-launch-readiness");
    expect(afterRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(afterRestart.eventLog.find((entry) => entry.eventId === "exec-pressure")?.occurredAt).toBe(triggerTime);
    expect(
      (await second.sourceChanges()).some((change) => change.record.title === "Launch date question for staff" && change.changeOccurredAt === triggerTime),
    ).toBe(true);
    await secondStorage.close();
  });
});

describePostgres("Postgres storage", () => {
  it("matches SQLite source-ledger behavior and persists across engine recreation", async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), "source-sim-pg-parity-")), "sqlite.sqlite");
    const sqliteStorage = new SQLiteSimulatorStorage(sqlitePath);
    const schema = `sim_test_parity_${Date.now()}`;
    const postgresStorage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
    let restartedStorage: PostgresSimulatorStorage | undefined;
    try {
      const sqlite = await SourceSimulator.create({ seed: "postgres-parity", storage: sqliteStorage, baseUrl: "http://sim.test" });
      const postgres = await SourceSimulator.create({ seed: "postgres-parity", storage: postgresStorage, baseUrl: "http://sim.test" });
      await sqlite.generateDataset({ seed: "postgres-parity-dataset", datasetSize: "medium" });
      await postgres.generateDataset({ seed: "postgres-parity-dataset", datasetSize: "medium" });
      await sqlite.advanceScenario("product-launch-readiness", { hours: 24 });
      await postgres.advanceScenario("product-launch-readiness", { hours: 24 });
      await sqlite.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
      await postgres.triggerScenarioEvent("product-launch-readiness", "exec-pressure");

      const postgresMetadata = await postgres.datasetMetadata();
      const sqliteMetadata = await sqlite.datasetMetadata();
      expect(postgresMetadata).toMatchObject({
        scenarioInstanceCount: sqliteMetadata.scenarioInstanceCount,
        totalSourceChanges: sqliteMetadata.totalSourceChanges,
        totalSourceObjects: sqliteMetadata.totalSourceObjects,
      });
      expect((await postgres.feed("conn-product-manager", undefined, 20)).records.map((record) => record.sourceId)).toEqual(
        (await sqlite.feed("conn-product-manager", undefined, 20)).records.map((record) => record.sourceId),
      );
      const metadataBeforeRestart = await postgres.datasetMetadata();
      await postgresStorage.close();

      restartedStorage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
      try {
        const restarted = await SourceSimulator.create({ seed: "ignored", storage: restartedStorage, baseUrl: "http://sim.test" });
        expect(await restarted.datasetMetadata()).toEqual(metadataBeforeRestart);
      } finally {
        await restartedStorage.dropOwnedSchemaForTesting();
        await restartedStorage.close();
      }
    } finally {
      await sqliteStorage.close();
      await postgresStorage.close();
      await restartedStorage?.close();
    }
  });

  it("rolls back failed Postgres world replacements and is accepted in production-like apps", async () => {
    const storage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema: `sim_test_atomic_${Date.now()}` });
    try {
      const simulator = await SourceSimulator.create({ seed: "postgres-atomic", storage, baseUrl: "http://sim.test" });
      const before = await storageWorldSnapshot(simulator);
      storage.injectWorldReplacementFailureForTesting();
      await expect(
        simulator.createScenarioInstance({
          scenarioPackId: "product-launch-readiness",
          scenarioInstanceId: "postgres-should-roll-back",
          seed: "postgres-rollback-seed",
        }),
      ).rejects.toThrow("Injected world replacement failure");
      expect(await storageWorldSnapshot(simulator)).toEqual(before);

      const app = await createApp({
        simulator,
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
      });
      const readiness = await app.request("/readyz");
      expect(readiness.status).toBe(200);
      expect((await readiness.json()).storage.kind).toBe("postgres");
    } finally {
      await storage.dropOwnedSchemaForTesting();
      await storage.close();
    }
  });

  it("persists clock state and shares production rate limits across Postgres-backed app instances", async () => {
    const schema = `sim_test_clock_rate_${Date.now()}`;
    const storageA = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
    let storageB: PostgresSimulatorStorage | undefined;
    try {
      const simulatorA = await SourceSimulator.create({
        seed: "postgres-clock-rate",
        storage: storageA,
        now: "2026-07-10T00:00:00.000Z",
        clockMode: "realtime",
        clockSpeedMultiplier: 60,
        baseUrl: "http://sim.test",
      });
      await simulatorA.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" });
      expect((await simulatorA.clockStatus()).clock.lastReconciledSimulationTime).toBe("2026-07-10T01:00:00.000Z");

      storageB = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
      const simulatorB = await SourceSimulator.create({ seed: "ignored", storage: storageB, baseUrl: "http://sim.test" });
      expect((await simulatorB.clockStatus()).clock.lastReconciledSimulationTime).toBe("2026-07-10T01:00:00.000Z");

      const appA = await createApp({
        simulator: simulatorA,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson: JSON.stringify({ enabled: true, windowMs: 60_000, adminLimit: 10, connectionLimit: 1, cronLimit: 10 }),
      });
      const appB = await createApp({
        simulator: simulatorB,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson: JSON.stringify({ enabled: true, windowMs: 60_000, adminLimit: 10, connectionLimit: 1, cronLimit: 10 }),
      });
      expect((await appA.request("/v1/connections/conn-product-manager/manifest", { headers: connectionHeaders("prod-product-manager") })).status).toBe(200);
      const limited = await appB.request("/v1/connections/conn-product-manager/manifest", { headers: connectionHeaders("prod-product-manager") });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toEqual(expect.any(String));
    } finally {
      await storageB?.close();
      await storageA.dropOwnedSchemaForTesting();
      await storageA.close();
    }
  });
});

describe("contract artifacts", () => {
  it("keeps OpenAPI and JSON Schema examples aligned with the runtime contract", async () => {
    const example = JSON.parse(await readFile(new URL("../../examples/jira-engineering-feed.v1.json", import.meta.url), "utf8"));
    expect(SourceFeedBatchV1Schema.safeParse(example).success).toBe(true);

    const openApi = await readFile(new URL("../../openapi/source-simulator.v1.yaml", import.meta.url), "utf8");
    const postgresMigration = await readFile(new URL("../../migrations/postgres_001_initial.sql", import.meta.url), "utf8");
    const postgresClockMigration = await readFile(new URL("../../migrations/postgres_002_clock_runtime.sql", import.meta.url), "utf8");
    const jsonSchema = JSON.parse(await readFile(new URL("../../schemas/source-feed-batch.v1.json", import.meta.url), "utf8"));

    expect(openApi).toContain("/sim/{sourceSystem}/{sourceId}");
    expect(openApi).toContain("/v1/admin/metrics");
    expect(openApi).toContain("/v1/admin/clock");
    expect(openApi).toContain("/api/cron/tick");
    for (const table of [
      "scenario_instance_states",
      "organization_config",
      "source_change_ledger",
      "source_objects",
      "dataset_metadata",
      "snapshots",
    ]) {
      expect(postgresMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const table of ["simulation_clock_state", "continuous_orchestration_state", "rate_limit_buckets"]) {
      expect(postgresClockMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(openApi).toContain("connectionBoundCredential");
    expect(openApi).toContain("cronBearer");
    expect(jsonSchema.$defs.sourceRecord.required).toContain("correlation");
  });
});
