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

type TestSQLiteStatement = {
  all(...parameters: unknown[]): unknown[];
};

type TestSQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): TestSQLiteStatement;
  close(): void;
};

const require = createRequire(import.meta.url);

function advancedSimulator(seed = "test-seed") {
  const simulator = new SourceSimulator({ seed, baseUrl: "http://sim.test" });
  simulator.advanceScenario("product-launch-readiness", { hours: 48 });
  simulator.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
  simulator.advanceScenario("reliability-incident", { hours: 48 });
  simulator.advanceScenario("renewal-risk", { hours: 48 });
  return simulator;
}

function completedDatasetSimulator(seed = "dataset-seed", datasetSize: "small" | "medium" | "large" = "small") {
  const simulator = new SourceSimulator({ seed, datasetSize, baseUrl: "http://sim.test" });
  simulator.generateDataset({ seed, datasetSize });
  return simulator;
}

function credentialedApp(simulator = advancedSimulator()) {
  const credentials = {
    "secret-product-manager": "conn-product-manager",
    "secret-product-ic": "conn-product-ic",
    "secret-product-vp": "conn-product-vp",
    "secret-cs-manager": "conn-customer-success-manager",
  };
  return {
    simulator,
    app: createApp({
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

function withEnv<T>(overrides: Record<string, string | undefined>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
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
  const rows = database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?, ?) ORDER BY name").all(
    "scenario_states",
    "scenario_instance_states",
    "organization_config",
    "snapshots",
    "world_state",
    "source_change_ledger",
    "source_objects",
    "dataset_metadata",
  ) as Array<{ name: string; sql: string }>;
  return Object.fromEntries(rows.map((row) => [row.name, normalizeSql(row.sql)]));
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function addHoursIso(start: string, hours: number): string {
  const date = new Date(start);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function storageWorldSnapshot(simulator: SourceSimulator) {
  return {
    worldRevision: simulator.datasetMetadata().worldRevision,
    metadata: simulator.datasetMetadata(),
    instanceStates: simulator.states(),
    sourceChanges: simulator.sourceChanges(),
    sourceObjects: simulator.sourceObjects(),
  };
}

const postgresTestUrl = process.env.SIMULATOR_POSTGRES_TEST_URL;
const describePostgres = postgresTestUrl ? describe : describe.skip;

describe("organization generation", () => {
  it("generates a deterministic multi-person reporting hierarchy", () => {
    const first = new SourceSimulator({ seed: "org-seed" });
    const second = new SourceSimulator({ seed: "org-seed" });
    const firstPeople = first.people().map((person) => person.id);
    const secondPeople = second.people().map((person) => person.id);

    expect(firstPeople).toEqual(secondPeople);
    expect(first.organizationSummary().validation.ok).toBe(true);
    expect(first.organizationSummary().counts.byRoleLevel.vp).toBeGreaterThanOrEqual(3);
    expect(first.organizationSummary().counts.byRoleLevel.director).toBeGreaterThan(3);
    expect(first.organizationSummary().counts.byRoleLevel.manager).toBeGreaterThan(6);
    expect(first.organizationSummary().counts.byRoleLevel.ic).toBeGreaterThan(24);
  });

  it("keeps reporting hierarchy separate from source visibility", () => {
    const simulator = advancedSimulator();
    const productIc = simulator.people().find((person) => person.roleTemplateId === "role-product-ic");
    const productVp = simulator.people().find((person) => person.roleTemplateId === "role-product-vp");
    expect(productIc?.managerId).toEqual(expect.any(String));
    expect(productVp?.managerId).toBeNull();
    expect(productVp?.directReportIds.length).toBeGreaterThan(0);

    const icRecords = simulator.recordsForPerson(productIc!.id).records;
    const vpRecords = simulator.recordsForPerson(productVp!.id).records;
    expect(icRecords.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(vpRecords.some((record) => record.title === "Launch date question for staff")).toBe(true);
  });

  it("preserves cycle-free hierarchy integrity", () => {
    const simulator = new SourceSimulator({ seed: "hierarchy-check" });
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
  it("produces deterministic records for the same seed and state", () => {
    const first = advancedSimulator("same-seed").allRecords().map((record) => record.sourceId);
    const second = advancedSimulator("same-seed").allRecords().map((record) => record.sourceId);
    const different = advancedSimulator("different-seed").allRecords().map((record) => record.sourceId);

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  it("paginates connection feeds with an opaque idempotent cursor", () => {
    const simulator = advancedSimulator();
    const first = simulator.feed("conn-product-manager", undefined, 2);
    const second = simulator.feed("conn-product-manager", first.nextCursor, 2);
    const retry = simulator.feed("conn-product-manager", first.nextCursor, 2);

    expect(SourceFeedBatchV1Schema.parse(first)).toEqual(first);
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.records.map((record) => record.changeId)).toEqual(retry.records.map((record) => record.changeId));
    expect(new Set([...first.records, ...second.records].map((record) => record.changeId)).size).toBe(4);
  });

  it("uses a compact v3 checkpoint cursor even for large ledgers", () => {
    const simulator = completedDatasetSimulator("large-cursor-seed", "large");
    const first = simulator.feed("conn-product-manager", undefined, 100);
    const cursorPayload = decodeCursor(first.nextCursor);

    expect(simulator.datasetMetadata().totalSourceChanges).toBeGreaterThanOrEqual(5_000);
    expect(first.nextCursor.length).toBeLessThan(256);
    expect(cursorPayload).toMatchObject({
      v: 3,
      connectionId: "conn-product-manager",
      worldRevision: simulator.datasetMetadata().worldRevision,
    });
    expect(cursorPayload.consumedChangeIds).toBeUndefined();
  });

  it("rejects stale cursors after a world revision change", () => {
    const simulator = new SourceSimulator({ seed: "stale-cursor-seed" });
    const first = simulator.feed("conn-product-manager", undefined, 10);
    simulator.resetScenario("product-launch-readiness", { seed: "new-scenario-seed" });

    expect(() => simulator.feed("conn-product-manager", first.nextCursor, 10)).toThrow("Stale checkpoint");
  });

  it("continues from a saved change checkpoint after new creates and updates", () => {
    const simulator = new SourceSimulator({ seed: "checkpoint-seed", baseUrl: "http://sim.test" });
    const initial = simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initial.nextCursor;
    const initiallyConsumed = new Set(initial.records.map((record) => record.changeId));

    simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const createdPage = simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(retryCreatedPage.records.map((record) => record.changeId));
    expect(createdPage.records.every((record) => !initiallyConsumed.has(record.changeId))).toBe(true);

    const createdDependency = createdPage.records.find((record) => record.title === "Workflow export API dependency");
    expect(createdDependency?.changeType).toBe("created");

    simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    const updatedPage = simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find((record) => record.sourceId === createdDependency?.sourceId);
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);

    const allChangeIds = [...initial.records, ...createdPage.records, ...updatedPage.records].map((record) => record.changeId);
    expect(new Set(allChangeIds).size).toBe(allChangeIds.length);
    expect(simulator.feed("conn-product-manager", updatedPage.nextCursor, 100).records).toEqual([]);
  });

  it("keeps same-pack scenario instances independent across advance, trigger, pause, reset, delete, and recreate", () => {
    const simulator = new SourceSimulator({ seed: "instance-independence-seed", baseUrl: "http://sim.test" });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-a",
      seed: "instance-a-seed",
      account: "Alpha Medical",
    });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-b",
      seed: "instance-b-seed",
      account: "Beta Foods",
    });
    const bInitial = simulator.scenarioInstance("independent-b").state;

    simulator.advanceScenarioInstance("independent-a", { hours: 24 });
    expect(simulator.scenarioInstance("independent-a").state.currentTime).not.toBe(bInitial.currentTime);
    expect(simulator.scenarioInstance("independent-b").state.currentTime).toBe(bInitial.currentTime);

    simulator.triggerScenarioInstanceEvent("independent-a", "exec-pressure");
    expect(simulator.scenarioInstance("independent-a").state.triggeredEventIds).toContain("exec-pressure");
    expect(simulator.scenarioInstance("independent-b").state.triggeredEventIds).not.toContain("exec-pressure");

    simulator.pauseScenarioInstance("independent-a");
    const pausedA = simulator.scenarioInstance("independent-a").state;
    simulator.advanceScenarioInstance("independent-a", { hours: 12 });
    simulator.advanceScenarioInstance("independent-b", { hours: 8 });
    expect(simulator.scenarioInstance("independent-a").state.currentTime).toBe(pausedA.currentTime);
    expect(simulator.scenarioInstance("independent-b").state.currentTime).not.toBe(bInitial.currentTime);

    const bBeforeReset = simulator.scenarioInstance("independent-b").state;
    simulator.resetScenarioInstance("independent-a", { seed: "instance-a-reset-seed" });
    expect(simulator.scenarioInstance("independent-a").state.currentTime).not.toBe(pausedA.currentTime);
    expect(simulator.scenarioInstance("independent-b").state).toEqual(bBeforeReset);

    simulator.deleteScenarioInstance("independent-a");
    expect(simulator.scenarioInstance("independent-b").state).toEqual(bBeforeReset);
    expect(() => simulator.scenarioInstance("independent-a")).toThrow("Unknown scenario instance");

    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-a",
      seed: "instance-a-recreated-seed",
      account: "Alpha Medical",
    });
    expect(simulator.scenarioInstance("independent-b").state).toEqual(bBeforeReset);
    expect(simulator.scenarioInstance("independent-a").state.seed).toBe("instance-a-recreated-seed");
  });

  it("keeps the ledger occurred-only and appends new creates and updates after a saved cursor", () => {
    const simulator = new SourceSimulator({ seed: "occurred-ledger-seed", baseUrl: "http://sim.test" });
    const initialWorldRevision = simulator.datasetMetadata().worldRevision;
    const initialChanges = simulator.sourceChanges();
    expect(initialChanges.some((change) => change.record.title === "Workflow export API dependency")).toBe(false);
    expect(initialChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);

    const initialPage = simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initialPage.nextCursor;
    simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    expect(simulator.datasetMetadata().worldRevision).toBe(initialWorldRevision);

    const afterCreateChanges = simulator.sourceChanges();
    expect(afterCreateChanges.slice(0, initialChanges.length).map((change) => change.changeId)).toEqual(
      initialChanges.map((change) => change.changeId),
    );
    expect(afterCreateChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);
    expect(new Set(afterCreateChanges.map((change) => change.changeId)).size).toBe(afterCreateChanges.length);

    const createdPage = simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(retryCreatedPage.records.map((record) => record.changeId));
    expect(createdPage.records.every((record) => Date.parse(record.changeOccurredAt) <= Date.parse(simulator.state("product-launch-readiness").currentTime))).toBe(true);
    const createdDependency = createdPage.records.find((record) => record.title === "Workflow export API dependency");
    expect(createdDependency?.changeType).toBe("created");

    simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    expect(simulator.datasetMetadata().worldRevision).toBe(initialWorldRevision);
    const updatedPage = simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find((record) => record.sourceId === createdDependency?.sourceId);
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);
  });

  it("uses current instance time for early manual triggers and delays updates from that occurrence time", () => {
    const simulator = new SourceSimulator({ seed: "manual-trigger-seed", baseUrl: "http://sim.test" });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "manual-trigger-a",
      seed: "manual-trigger-a-seed",
    });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "manual-trigger-b",
      seed: "manual-trigger-b-seed",
    });
    const beforeTrigger = simulator.scenarioInstance("manual-trigger-a").state;
    const triggerTime = beforeTrigger.currentTime;
    expect(triggerTime).not.toBe(addHoursIso(beforeTrigger.startedAt, 36));

    const savedCursor = simulator.feed("conn-product-vp", undefined, 100).nextCursor;
    simulator.triggerScenarioInstanceEvent("manual-trigger-a", "exec-pressure");
    const triggered = simulator.scenarioInstance("manual-trigger-a").state;
    const triggeredEvent = triggered.eventLog.find((entry) => entry.eventId === "exec-pressure");
    expect(triggered.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(triggeredEvent?.occurredAt).toBe(triggerTime);

    const triggeredPage = simulator.feed("conn-product-vp", savedCursor, 100);
    expect(triggeredPage.records.some((record) => record.title === "Launch date question for staff" && record.changeType === "created")).toBe(true);
    expect(triggeredPage.records.some((record) => record.title === "Launch decision update" && record.changeType === "created")).toBe(true);
    expect(triggeredPage.records.some((record) => record.title === "Launch decision update" && record.changeType === "updated")).toBe(false);
    expect(
      simulator.sourceChanges().some((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated"),
    ).toBe(false);

    simulator.advanceScenarioInstance("manual-trigger-a", { hours: 7 });
    expect(
      simulator.sourceChanges().some((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated"),
    ).toBe(false);

    simulator.advanceScenarioInstance("manual-trigger-a", { hours: 1 });
    const updatedChange = simulator.sourceChanges().find((change) => change.scenarioInstanceId === "manual-trigger-a" && change.record.title === "Launch decision update" && change.changeType === "updated");
    expect(updatedChange?.changeOccurredAt).toBe(addHoursIso(triggerTime, 8));
    expect(updatedChange?.record.updatedAt).toBe(addHoursIso(triggerTime, 8));

    const changeCountBeforeRetry = simulator.sourceChanges().length;
    simulator.triggerScenarioInstanceEvent("manual-trigger-a", "exec-pressure");
    const afterRetry = simulator.scenarioInstance("manual-trigger-a").state;
    expect(afterRetry.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(afterRetry.eventLog.filter((entry) => entry.eventId === "exec-pressure")).toHaveLength(1);
    expect(simulator.sourceChanges()).toHaveLength(changeCountBeforeRetry);

    const peer = simulator.scenarioInstance("manual-trigger-b").state;
    expect(peer.triggeredEventIds).not.toContain("exec-pressure");
    expect(peer.eventOccurrenceTimes["exec-pressure"]).toBeUndefined();
    expect(peer.eventLog.some((entry) => entry.eventId === "exec-pressure")).toBe(false);

    simulator.advanceScenarioInstance("manual-trigger-b", { hours: 30 });
    const peerAfterAdvance = simulator.scenarioInstance("manual-trigger-b").state;
    expect(peerAfterAdvance.eventLog.find((entry) => entry.eventId === "dependency-risk")?.occurredAt).toBe(addHoursIso(peer.startedAt, 24));
    expect(peerAfterAdvance.currentTime).toBe(addHoursIso(peer.startedAt, 30));
  });

  it("calculates manual-trigger deletions from actual trigger time", () => {
    const simulator = new SourceSimulator({ seed: "manual-delete-seed", baseUrl: "http://sim.test" });
    const beforeTrigger = simulator.state("technical-debt-staffing-risk");
    const triggerTime = beforeTrigger.currentTime;
    expect(triggerTime).not.toBe(addHoursIso(beforeTrigger.startedAt, 80));

    simulator.triggerScenarioEvent("technical-debt-staffing-risk", "vp-investment");
    const created = simulator.sourceChanges().find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "created");
    expect(created?.changeOccurredAt).toBe(triggerTime);
    expect(simulator.sourceChanges().some((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted")).toBe(false);

    simulator.advanceScenario("technical-debt-staffing-risk", { hours: 35 });
    expect(simulator.sourceChanges().some((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted")).toBe(false);

    simulator.advanceScenario("technical-debt-staffing-risk", { hours: 1 });
    const deleted = simulator.sourceChanges().find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted");
    expect(deleted?.sourceId).toBe(created?.sourceId);
    expect(deleted?.changeOccurredAt).toBe(addHoursIso(triggerTime, 36));
    expect(deleted?.record.updatedAt).toBe(addHoursIso(triggerTime, 36));
  });

  it("filters executive-only records away from IC, Manager, and Director connections", () => {
    const simulator = advancedSimulator();
    const productIc = simulator.feed("conn-product-ic", undefined, 100);
    const productManager = simulator.feed("conn-product-manager", undefined, 100);
    const productDirector = simulator.feed("conn-product-director", undefined, 100);
    const productVp = simulator.feed("conn-product-vp", undefined, 100);

    expect(productIc.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productManager.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productDirector.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productVp.records.some((record) => record.title === "Launch date question for staff")).toBe(true);
  });

  it("keeps cross-department source access permission-scoped", () => {
    const simulator = advancedSimulator();
    const productManager = simulator.feed("conn-product-manager", undefined, 100);
    const customerSuccessManager = simulator.feed("conn-customer-success-manager", undefined, 100);

    expect(productManager.records.some((record) => record.title === "Workflow export API dependency")).toBe(true);
    expect(customerSuccessManager.records.some((record) => record.title === "Workflow export API dependency")).toBe(false);
  });

  it("restores snapshots exactly, including organization config", () => {
    const simulator = advancedSimulator();
    const before = simulator.allRecords().map((record) => record.sourceId).sort();
    const snapshot = simulator.createSnapshot();
    simulator.regenerateOrganization({ seed: "changed-org" });
    simulator.restoreSnapshot(snapshot.snapshotId);
    const after = simulator.allRecords().map((record) => record.sourceId).sort();

    expect(after).toEqual(before);
  });

  it("replays deterministically from a restored snapshot", () => {
    const simulator = new SourceSimulator({ seed: "replay-seed" });
    simulator.advanceScenario("reliability-incident", { hours: 5 });
    const snapshot = simulator.createSnapshot();
    const before = simulator.feed("conn-engineering-manager", undefined, 100).records.map((record) => record.sourceId);

    simulator.advanceScenario("reliability-incident", { hours: 30 });
    simulator.restoreSnapshot(snapshot.snapshotId);
    const after = simulator.feed("conn-engineering-manager", undefined, 100).records.map((record) => record.sourceId);

    expect(after).toEqual(before);
  });

  it("restores multiple scenario instances independently and rebuilds a deterministic ledger under a new revision", () => {
    const simulator = new SourceSimulator({ seed: "snapshot-instance-seed", baseUrl: "http://sim.test" });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "snapshot-a",
      seed: "snapshot-a-seed",
      account: "Snapshot Alpha",
    });
    simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "snapshot-b",
      seed: "snapshot-b-seed",
      account: "Snapshot Beta",
    });
    simulator.advanceScenarioInstance("snapshot-a", { hours: 24 });
    simulator.advanceScenarioInstance("snapshot-b", { hours: 8 });
    const snapshot = simulator.createSnapshot();
    const aAtSnapshot = simulator.scenarioInstance("snapshot-a").state;
    const bAtSnapshot = simulator.scenarioInstance("snapshot-b").state;
    const cursorBeforeRestore = simulator.feed("conn-product-manager", undefined, 100).nextCursor;
    const revisionBeforeRestore = simulator.datasetMetadata().worldRevision;

    simulator.advanceScenarioInstance("snapshot-a", { hours: 30 });
    simulator.triggerScenarioInstanceEvent("snapshot-b", "exec-pressure");
    simulator.restoreSnapshot(snapshot.snapshotId);
    const firstRestoreRevision = simulator.datasetMetadata().worldRevision;
    const firstRestoreLedger = simulator.sourceChanges().map((change) => ({ ...change, worldRevision: "<ignored>" }));

    expect(firstRestoreRevision).not.toBe(revisionBeforeRestore);
    expect(() => simulator.feed("conn-product-manager", cursorBeforeRestore, 100)).toThrow("Stale checkpoint");
    expect(simulator.scenarioInstance("snapshot-a").state).toEqual(aAtSnapshot);
    expect(simulator.scenarioInstance("snapshot-b").state).toEqual(bAtSnapshot);

    simulator.advanceScenarioInstance("snapshot-a", { hours: 1 });
    simulator.restoreSnapshot(snapshot.snapshotId);
    const secondRestoreLedger = simulator.sourceChanges().map((change) => ({ ...change, worldRevision: "<ignored>" }));
    expect(secondRestoreLedger).toEqual(firstRestoreLedger);
  });

  it("does not expose source updates before the simulation clock reaches the update time", () => {
    const simulator = new SourceSimulator({ seed: "temporal-seed", baseUrl: "http://sim.test" });

    expect(simulator.feed("conn-product-manager", undefined, 100).records.some((record) => record.title === "Workflow export API dependency")).toBe(false);

    simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const created = simulator.allRecords().find((record) => record.title === "Workflow export API dependency");
    expect(created).toBeDefined();
    expect(created?.updatedAt).toBeUndefined();
    expect(created?.rawPayload.simulatorVersion).toBe("initial");

    simulator.advanceScenario("product-launch-readiness", { hours: 5 });
    const beforeUpdate = simulator.allRecords().find((record) => record.sourceId === created?.sourceId);
    expect(beforeUpdate?.updatedAt).toBeUndefined();

    simulator.advanceScenario("product-launch-readiness", { hours: 1 });
    const updated = simulator.allRecords().find((record) => record.sourceId === created?.sourceId);
    expect(updated?.sourceId).toBe(created?.sourceId);
    expect(updated?.updatedAt).toBe("2026-07-11T22:00:00.000Z");
    expect(updated?.rawPayload.simulatorVersion).toBe("updated");
  });

  it("emits timeline mutations as source-object versions with stable identity", () => {
    const simulator = new SourceSimulator({ seed: "feed-update-seed", baseUrl: "http://sim.test" });
    simulator.advanceScenario("reliability-incident", { hours: 5 });
    const initialPage = simulator.feed("conn-engineering-manager", undefined, 100);
    const initial = initialPage.records.find((record) => record.title === "Throttle connector retries under queue pressure");
    expect(initial?.updatedAt).toBeUndefined();
    expect(initial?.changeType).toBe("created");

    simulator.advanceScenario("reliability-incident", { hours: 3 });
    const afterUpdate = simulator.feed("conn-engineering-manager", initialPage.nextCursor, 100).records.find((record) => record.sourceId === initial?.sourceId);
    expect(afterUpdate?.sourceId).toBe(initial?.sourceId);
    expect(afterUpdate?.updatedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(afterUpdate?.changeType).toBe("updated");
  });

  it("preserves source identity across created, updated, and deleted history entries", () => {
    const simulator = completedDatasetSimulator("history-seed", "small");
    const deletedChange = simulator.sourceChanges().find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted");
    expect(deletedChange).toBeDefined();

    const history = simulator.sourceObjectHistory(deletedChange!.sourceSystem, deletedChange!.sourceId);
    expect(history.map((change) => change.sourceId)).toEqual(history.map(() => deletedChange!.sourceId));
    expect(history.map((change) => change.changeType)).toEqual(["created", "deleted"]);
  });
});

describe("Milestone 2 scenario packs and adapters", () => {
  it("registers all required source adapters and validates emitted provider payloads", () => {
    const simulator = completedDatasetSimulator("adapter-seed", "small");
    expect(sourceAdapters.map((adapter) => adapter.sourceSystem).sort()).toEqual([...sourceSystems].sort());

    for (const adapter of sourceAdapters) {
      const change = simulator.sourceChanges().find((candidate) => candidate.sourceSystem === adapter.sourceSystem);
      expect(change, adapter.sourceSystem).toBeDefined();
      expect(adapter.validatePayload(change!.record.rawPayload)).toEqual({ ok: true, errors: [] });
      expect(change!.record.rawPayload.actor).toMatchObject({ id: expect.any(String), email: expect.stringContaining("@example.test") });
      expect(adapter.buildSourceUrl({ baseUrl: "http://sim.test", sourceId: "source-123" })).toBe(
        `http://sim.test/sim/${adapter.sourceSystem}/source-123`,
      );
    }
  });

  it("covers all ten scenario packs, departments, levels, and source systems", () => {
    const simulator = new SourceSimulator({ seed: "pack-seed" });
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

  it("generates deterministic dataset sizes inside documented change-count ranges", () => {
    const small = completedDatasetSimulator("dataset-seed", "small").datasetMetadata();
    const medium = completedDatasetSimulator("dataset-seed", "medium").datasetMetadata();
    const mediumReplay = completedDatasetSimulator("dataset-seed", "medium").datasetMetadata();
    const large = completedDatasetSimulator("dataset-seed", "large").datasetMetadata();

    expect(small.totalSourceChanges).toBeGreaterThanOrEqual(100);
    expect(small.totalSourceChanges).toBeLessThanOrEqual(250);
    expect(medium.totalSourceChanges).toBeGreaterThanOrEqual(1_000);
    expect(medium.totalSourceChanges).toBeLessThanOrEqual(2_500);
    expect(large.totalSourceChanges).toBeGreaterThanOrEqual(5_000);
    expect(large.totalSourceChanges).toBeLessThanOrEqual(10_000);
    expect(medium).toEqual(mediumReplay);
  });

  it("keeps cross-functional relationships explicit and separate from primary reporting", () => {
    const simulator = new SourceSimulator({ seed: "relationship-seed" });
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
    const { app } = credentialedApp();

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
    const { app } = credentialedApp();

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
    const { app } = credentialedApp();
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

  it("rejects memory and SQLite storage in production-like runtimes, including injected options", () => {
    const productionCredentials = { "prod-product-manager": "conn-product-manager" };
    expect(() =>
      withEnv(
        { SIMULATOR_STORAGE_DRIVER: "sqlite", SIMULATOR_ALLOW_EPHEMERAL_MEMORY: undefined, DATABASE_URL: undefined },
        () => createApp({ runtimeEnv: "preview", adminKey: "prod-admin", connectionCredentials: productionCredentials }),
      ),
    ).toThrow(/SQLite storage is forbidden/);
    expect(() =>
      withEnv(
        { SIMULATOR_STORAGE_DRIVER: "memory", SIMULATOR_ALLOW_EPHEMERAL_MEMORY: "true", DATABASE_URL: undefined },
        () => createApp({ runtimeEnv: "production", adminKey: "prod-admin", connectionCredentials: productionCredentials }),
      ),
    ).toThrow(/memory storage.*forbidden/i);
    expect(() =>
      createApp({
        storage: new MemorySimulatorStorage(),
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: productionCredentials,
      }),
    ).toThrow(/Injected storage uses memory storage/);

    const sqlitePath = join(mkdtempSync(join(tmpdir(), "source-sim-prod-")), "simulator.sqlite");
    const sqliteStorage = new SQLiteSimulatorStorage(sqlitePath);
    try {
      expect(() =>
        createApp({
          storage: sqliteStorage,
          runtimeEnv: "production",
          adminKey: "prod-admin",
          connectionCredentials: productionCredentials,
        }),
      ).toThrow(/Injected storage uses SQLite storage/);
    } finally {
      sqliteStorage.close();
    }

    const injectedSimulator = new SourceSimulator({ storage: new MemorySimulatorStorage() });
    expect(() =>
      createApp({
        simulator: injectedSimulator,
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: productionCredentials,
      }),
    ).toThrow(/Injected simulator storage uses memory storage/);
  });

  it("keeps connection authentication consistent after organization regeneration", async () => {
    const simulator = new SourceSimulator({ seed: "regen-auth-seed", baseUrl: "http://sim.test" });
    const app = createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
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
    const { app } = credentialedApp();
    const response = await app.request("/v1/admin/scenarios/product-launch-readiness/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
  });

  it("enforces organization and pagination bounds", async () => {
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      schemaVersion: "simulator-health.v1",
      contractVersion: "source-feed.v1",
      storage: { kind: "memory", ok: true },
    });
    expect(healthBody.worldRevision).toMatch(/^world-/);

    await app.request("/v1/connections/conn-product-manager/records?limit=2", {
      headers: connectionHeaders("secret-product-manager"),
    });
    const metrics = await app.request("/v1/admin/metrics", { headers: adminHeaders() });
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.json();
    expect(metricsBody.schemaVersion).toBe("simulator-metrics.v1");
    expect(metricsBody.requests.total).toBeGreaterThan(0);
    expect(metricsBody.simulator.sourceChanges).toBeGreaterThan(0);
    expect(metricsBody.simulator.worldRevision).toBe(healthBody.worldRevision);

    const requests = await app.request("/v1/admin/requests", { headers: adminHeaders() });
    expect((await requests.json()).requests.some((request: { connectionId?: string }) => request.connectionId === "conn-product-manager")).toBe(true);

    const storage = await app.request("/v1/admin/storage", { headers: adminHeaders() });
    expect((await storage.json()).counts.sourceChanges).toBeGreaterThan(0);
  });

  it("applies deterministic failure modes without random behavior", async () => {
    const { app } = credentialedApp();
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
    const { app } = credentialedApp();
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
    const { app } = credentialedApp(completedDatasetSimulator("api-m2-seed", "medium"));

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
    const { app, simulator } = credentialedApp(new SourceSimulator({ seed: "api-create-seed", baseUrl: "http://sim.test" }));
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
    expect(simulator.scenarioInstance("api-created-instance").state.seed).toBe("api-created-seed");

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
    const firstSimulator = new SourceSimulator({ seed: "sqlite-instance-create", storage: firstStorage, baseUrl: "http://sim.test" });
    const { app } = credentialedApp(firstSimulator);
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
    const secondSimulator = new SourceSimulator({ seed: "ignored-seed", storage: secondStorage, baseUrl: "http://sim.test" });
    expect(secondSimulator.scenarioInstance("sqlite-created-instance").state).toMatchObject({
      scenarioPackId: "reliability-incident",
      seed: "sqlite-created-seed",
      service: "connector-gateway",
    });
    secondStorage.close();
  });

  it("does not expose future changes through the admin source-change route", async () => {
    const { app } = credentialedApp(new SourceSimulator({ seed: "api-ledger-seed", baseUrl: "http://sim.test" }));
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
    const { app } = credentialedApp();
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
        source_change_ledger: "CREATE TABLE source_change_ledger ( ledger_sequence INTEGER PRIMARY KEY, world_revision TEXT NOT NULL, change_json TEXT NOT NULL )",
        source_objects: "CREATE TABLE source_objects ( source_key TEXT PRIMARY KEY, world_revision TEXT NOT NULL, object_json TEXT NOT NULL )",
        snapshots: "CREATE TABLE snapshots ( snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL )",
        world_state: "CREATE TABLE world_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), world_revision TEXT NOT NULL )",
      };
      expect(durableTableSql(migrationDatabase)).toEqual(expectedSchema);
      expect(durableTableSql(runtimeDatabase)).toEqual(expectedSchema);
    } finally {
      migrationDatabase.close();
      runtimeDatabase.close();
    }
  });

  it("rolls back failed world replacement during scenario instance creation", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-create-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = new SourceSimulator({ seed: "atomic-create-seed", storage, baseUrl: "http://sim.test" });
    const before = storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    expect(() =>
      simulator.createScenarioInstance({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "should-roll-back",
        seed: "should-roll-back-seed",
      }),
    ).toThrow("Injected world replacement failure");

    expect(storageWorldSnapshot(simulator)).toEqual(before);
    expect(() => simulator.scenarioInstance("should-roll-back")).toThrow("Unknown scenario instance");
    storage.close();
  });

  it("rolls back failed world replacement during scenario instance reset", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-reset-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = new SourceSimulator({ seed: "atomic-reset-seed", storage, baseUrl: "http://sim.test" });
    simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const before = storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    expect(() => simulator.resetScenarioInstance("product-launch-readiness-default", { seed: "failed-reset-seed" })).toThrow(
      "Injected world replacement failure",
    );

    expect(storageWorldSnapshot(simulator)).toEqual(before);
    storage.close();
  });

  it("rolls back failed world replacement during dataset generation", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-atomic-dataset-")), "simulator.sqlite");
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = new SourceSimulator({ seed: "atomic-dataset-seed", storage, baseUrl: "http://sim.test" });
    const before = storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    expect(() => simulator.generateDataset({ seed: "failed-dataset-seed", datasetSize: "medium" })).toThrow("Injected world replacement failure");

    expect(storageWorldSnapshot(simulator)).toEqual(before);
    storage.close();
  });

  it("persists scenario states, organization config, and snapshots across engine recreation", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = new SourceSimulator({ seed: "sqlite-seed", storage: firstStorage });
    first.advanceScenario("product-launch-readiness", { hours: 24 });
    first.regenerateOrganization({ seed: "sqlite-org-seed" });
    const snapshot = first.createSnapshot();
    const stateBefore = first.state("product-launch-readiness");
    const metadataBefore = first.datasetMetadata();
    const firstCursor = first.feed("conn-product-manager", undefined, 10).nextCursor;
    firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = new SourceSimulator({ seed: "other-seed", storage: secondStorage });
    expect(second.state("product-launch-readiness").currentTime).toBe(stateBefore.currentTime);
    expect(second.organizationSummary().seed).toBe("sqlite-org-seed");
    expect(second.listSnapshots().map((candidate) => candidate.snapshotId)).toContain(snapshot.snapshotId);
    expect(second.datasetMetadata()).toEqual(metadataBefore);
    expect(second.feed("conn-product-manager", firstCursor, 10).worldRevision).toBe(metadataBefore.worldRevision);
    expect(second.sourceChanges().length).toBe(metadataBefore.totalSourceChanges);
    secondStorage.close();
  });

  it("persists manual trigger occurrence time across engine recreation", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-manual-trigger-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = new SourceSimulator({ seed: "sqlite-manual-trigger-seed", storage: firstStorage, baseUrl: "http://sim.test" });
    const triggerTime = first.state("product-launch-readiness").currentTime;
    first.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
    const beforeRestart = first.state("product-launch-readiness");
    expect(beforeRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = new SourceSimulator({ seed: "ignored-seed", storage: secondStorage, baseUrl: "http://sim.test" });
    const afterRestart = second.state("product-launch-readiness");
    expect(afterRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(afterRestart.eventLog.find((entry) => entry.eventId === "exec-pressure")?.occurredAt).toBe(triggerTime);
    expect(
      second.sourceChanges().some((change) => change.record.title === "Launch date question for staff" && change.changeOccurredAt === triggerTime),
    ).toBe(true);
    secondStorage.close();
  });
});

describePostgres("Postgres storage", () => {
  it("matches SQLite source-ledger behavior and persists across engine recreation", () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), "source-sim-pg-parity-")), "sqlite.sqlite");
    const sqliteStorage = new SQLiteSimulatorStorage(sqlitePath);
    const postgresStorage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, resetForTesting: true });
    try {
      const sqlite = new SourceSimulator({ seed: "postgres-parity", storage: sqliteStorage, baseUrl: "http://sim.test" });
      const postgres = new SourceSimulator({ seed: "postgres-parity", storage: postgresStorage, baseUrl: "http://sim.test" });
      sqlite.generateDataset({ seed: "postgres-parity-dataset", datasetSize: "medium" });
      postgres.generateDataset({ seed: "postgres-parity-dataset", datasetSize: "medium" });
      sqlite.advanceScenario("product-launch-readiness", { hours: 24 });
      postgres.advanceScenario("product-launch-readiness", { hours: 24 });
      sqlite.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
      postgres.triggerScenarioEvent("product-launch-readiness", "exec-pressure");

      expect(postgres.datasetMetadata()).toMatchObject({
        scenarioInstanceCount: sqlite.datasetMetadata().scenarioInstanceCount,
        totalSourceChanges: sqlite.datasetMetadata().totalSourceChanges,
        totalSourceObjects: sqlite.datasetMetadata().totalSourceObjects,
      });
      expect(postgres.feed("conn-product-manager", undefined, 20).records.map((record) => record.sourceId)).toEqual(
        sqlite.feed("conn-product-manager", undefined, 20).records.map((record) => record.sourceId),
      );
      const metadataBeforeRestart = postgres.datasetMetadata();
      postgresStorage.close();

      const restartedStorage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, resetForTesting: false });
      try {
        const restarted = new SourceSimulator({ seed: "ignored", storage: restartedStorage, baseUrl: "http://sim.test" });
        expect(restarted.datasetMetadata()).toEqual(metadataBeforeRestart);
      } finally {
        restartedStorage.close();
      }
    } finally {
      sqliteStorage.close();
      postgresStorage.close();
    }
  });

  it("rolls back failed Postgres world replacements and is accepted in production-like apps", async () => {
    const storage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, resetForTesting: true });
    try {
      const simulator = new SourceSimulator({ seed: "postgres-atomic", storage, baseUrl: "http://sim.test" });
      const before = storageWorldSnapshot(simulator);
      storage.injectWorldReplacementFailureForTesting();
      expect(() =>
        simulator.createScenarioInstance({
          scenarioPackId: "product-launch-readiness",
          scenarioInstanceId: "postgres-should-roll-back",
          seed: "postgres-rollback-seed",
        }),
      ).toThrow("Injected world replacement failure");
      expect(storageWorldSnapshot(simulator)).toEqual(before);

      const app = createApp({
        simulator,
        runtimeEnv: "preview",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
      });
      const health = await app.request("/healthz");
      expect(health.status).toBe(200);
      expect((await health.json()).storage.kind).toBe("postgres");
    } finally {
      storage.close();
    }
  });
});

describe("contract artifacts", () => {
  it("keeps OpenAPI and JSON Schema examples aligned with the runtime contract", async () => {
    const example = JSON.parse(await readFile(new URL("../../examples/jira-engineering-feed.v1.json", import.meta.url), "utf8"));
    expect(SourceFeedBatchV1Schema.safeParse(example).success).toBe(true);

    const openApi = await readFile(new URL("../../openapi/source-simulator.v1.yaml", import.meta.url), "utf8");
    const postgresMigration = await readFile(new URL("../../migrations/postgres_001_initial.sql", import.meta.url), "utf8");
    const jsonSchema = JSON.parse(await readFile(new URL("../../schemas/source-feed-batch.v1.json", import.meta.url), "utf8"));

    expect(openApi).toContain("/sim/{sourceSystem}/{sourceId}");
    expect(openApi).toContain("/v1/admin/metrics");
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
    expect(openApi).toContain("connectionBoundCredential");
    expect(jsonSchema.$defs.sourceRecord.required).toContain("correlation");
  });
});
