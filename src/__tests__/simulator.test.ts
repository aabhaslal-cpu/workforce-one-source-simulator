import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { SourceFeedBatchV1Schema } from "../contracts.js";
import { SourceSimulator } from "../engine.js";
import { createApp } from "../simulator-app.js";
import { sourceAdapters } from "../adapters/registry.js";
import {
  assertNoSimulatorMetadata,
  canonicalPayloadFamily,
  canonicalVendorPayloadFamilies,
  validateVendorPayload,
  vendorPayloadSchemas,
} from "../adapters/vendor-schemas.js";
import { defaultOrganizationConfig, personConnectionId } from "../organization.js";
import {
  MemorySimulatorStorage,
  PostgresSimulatorStorage,
  SQLiteSimulatorStorage,
} from "../storage.js";
import {
  sourceSystems,
  type Person,
  type SourceChangeLedgerEntry,
  type SourceRecord,
  type SourceSystem,
} from "../domain.js";
import type { SourceEmissionInput } from "../adapters/types.js";
import { assertBenchmarkDatabaseIsIsolated } from "../performance.js";
import { SOURCE_PAYLOAD_CONTRACT_VERSION, sourceContractManifests } from "../source-contracts.js";
import { preserveNoBodyDeletionPayloads } from "../source-lifecycle.js";

type TestSQLiteStatement = {
  all(...parameters: unknown[]): unknown[];
};

type TestSQLiteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): TestSQLiteStatement;
  close(): void;
};

type VendorPayloadFixture = {
  sourceSystem: SourceSystem;
  family: string;
  provenanceUrl: string;
  payload: Record<string, unknown>;
};

type SourceDraftForTest = {
  sourceUrl: string;
  objectType?: string;
  rawPayload: Record<string, unknown>;
};

const require = createRequire(import.meta.url);
const { Pool } = pg;

async function advancedSimulator(seed = "test-seed") {
  const simulator = await SourceSimulator.create({ seed, baseUrl: "http://sim.test" });
  await simulator.advanceScenario("product-launch-readiness", { hours: 48 });
  await simulator.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
  await simulator.advanceScenario("reliability-incident", { hours: 48 });
  await simulator.advanceScenario("renewal-risk", { hours: 48 });
  return simulator;
}

async function completedDatasetSimulator(
  seed = "dataset-seed",
  datasetSize: "small" | "medium" | "large" = "small",
) {
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

function recordsBySourceAndFamily(changes: SourceChangeLedgerEntry[]): Map<string, SourceRecord> {
  const records = new Map<string, SourceRecord>();
  for (const change of changes) {
    records.set(`${change.sourceSystem}:${change.record.objectType}`, change.record);
  }
  return records;
}

async function loadVendorPayloadFixtures(): Promise<VendorPayloadFixture[]> {
  return JSON.parse(
    await readFile(
      join(process.cwd(), "fixtures/vendor-payloads/source-payload-fixtures.json"),
      "utf8",
    ),
  ) as VendorPayloadFixture[];
}

function representativeObjectType(sourceSystem: SourceSystem, family: string): string {
  const representative: Partial<Record<SourceSystem, Record<string, string>>> = {
    slack: { message: "message" },
    gmail: { message: "email", thread: "thread" },
    calendar: { event: "meeting" },
    notion: { page: "page" },
    jira: { issue: "issue" },
    productboard: { feature: "feature", note: "insight" },
    amplitude: { chart_response: "metric_snapshot" },
    github: {
      issue: "issue",
      pull_request: "pull_request",
      commit: "commit",
      release: "release",
    },
    pagerduty: { incident: "incident" },
    salesforce: {
      Account: "account",
      Contact: "contact",
      Event: "event",
      Opportunity: "opportunity",
      Task: "task",
    },
    gainsight: {
      CallToAction: "cta",
      ScorecardMeasure: "health_score",
      SuccessPlan: "success_plan",
      TimelineActivity: "milestone",
    },
    zendesk: { ticket: "ticket" },
  };
  return representative[sourceSystem]?.[family] ?? family;
}

function testPerson(overrides: Partial<Person> = {}): Person {
  return {
    id: "person-test-ic",
    stableKey: "person-test-ic",
    name: "Fictional Tester",
    email: "fictional.tester@example.test",
    department: "engineering",
    roleTemplateId: "role-engineering-ic",
    roleTitle: "Engineer",
    roleLevel: "ic",
    teamId: "team-test",
    managerId: null,
    directReportIds: [],
    sourceIdentities: {},
    groupMemberships: [],
    assignedProjects: [],
    assignedProducts: [],
    assignedAccounts: [],
    assignedWorkstreams: [],
    permissionScopes: [],
    ...overrides,
  };
}

function emissionInput(
  sourceSystem: SourceSystem,
  objectType: string,
  overrides: Partial<SourceEmissionInput> = {},
): SourceEmissionInput {
  const actor = testPerson();
  return {
    baseUrl: "http://sim.test",
    sourceId: `${sourceSystem}-test-source`,
    occurredAt: "2026-07-10T00:00:00.000Z",
    changeOccurredAt: "2026-07-10T04:00:00.000Z",
    changeType: "deleted",
    scenario: {
      id: "test-scenario",
      title: "Test scenario",
      department: "engineering",
      description: "Test",
      participantRoleTemplateIds: ["role-engineering-ic"],
      sourceSystems: [sourceSystem],
      events: [],
    },
    event: { id: "test-event", label: "Test event", atHour: 0, records: [] },
    template: {
      id: "test-template",
      sourceSystem,
      objectType,
      title: "Test source record",
      actorRoleTemplateId: "role-engineering-ic",
      acl: { visibility: "public", groups: [], users: [] },
      rawPayload: {},
    },
    state: {
      scenarioPackId: "test-scenario",
      scenarioInstanceId: "test-scenario-1",
      instanceIndex: 0,
      label: "Test scenario 1",
      seed: "test-seed",
      datasetSize: "small",
      startedAt: "2026-07-10T00:00:00.000Z",
      currentTime: "2026-07-10T04:00:00.000Z",
      paused: false,
      triggeredEventIds: [],
      eventOccurrenceTimes: {},
      eventLog: [],
      completionState: "active",
      participantPersonIds: { "role-engineering-ic": actor.id },
      account: "Example Account",
      product: "Example Product",
      project: "Example Project",
      service: "Example Service",
      workstream: "Example Workstream",
      timeOffsetHours: 0,
    },
    instance: {
      scenarioPackId: "test-scenario",
      scenarioInstanceId: "test-scenario-1",
      instanceIndex: 0,
      label: "Test scenario 1",
      seed: "test-seed",
      account: "Example Account",
      product: "Example Product",
      project: "Example Project",
      service: "Example Service",
      workstream: "Example Workstream",
      timeOffsetHours: 0,
    },
    organization: {
      seed: "test-seed",
      config: cloneDefaultOrganizationConfig(),
      roleTemplates: [],
      people: [actor],
      teams: [],
      reportingRelationships: [],
      tree: [],
      counts: {
        totalPeople: 1,
        byDepartment: { product: 0, engineering: 1, customer_success: 0 },
        byRoleLevel: { ic: 1, manager: 0, director: 0, vp: 0 },
      },
      validation: { ok: true, errors: [] },
    },
    actor,
    assignee: null,
    managerChain: [],
    ...overrides,
  };
}

function adapterDraft(
  sourceSystem: SourceSystem,
  objectType: string,
  changeType: "created" | "updated" | "deleted",
  rawPayload: Record<string, unknown> = {},
): { input: SourceEmissionInput; draft: SourceDraftForTest } {
  const adapter = sourceAdapters.find((candidate) => candidate.sourceSystem === sourceSystem)!;
  const input = emissionInput(sourceSystem, objectType, {
    changeType,
    changeOccurredAt:
      changeType === "created"
        ? "2026-07-10T00:00:00.000Z"
        : changeType === "updated"
          ? "2026-07-10T02:00:00.000Z"
          : "2026-07-10T04:00:00.000Z",
  });
  input.template.rawPayload = rawPayload;
  const draft =
    changeType === "created"
      ? adapter.create(input)
      : changeType === "updated"
        ? adapter.update(input)
        : adapter.remove(input);
  return { input, draft };
}

function ledgerChangeForDraft(
  sourceSystem: SourceSystem,
  objectType: string,
  changeType: "created" | "updated" | "deleted",
  sequence: number,
  rawPayload: Record<string, unknown> = {},
): SourceChangeLedgerEntry {
  const { input, draft } = adapterDraft(sourceSystem, objectType, changeType, rawPayload);
  const record: SourceRecord = {
    schemaVersion: "source-record.v1",
    sourceSystem,
    sourceId: input.sourceId,
    objectType: draft.objectType ?? objectType,
    occurredAt: input.occurredAt,
    title: input.template.title,
    sourceUrl: draft.sourceUrl,
    actorRef: input.actor.id,
    acl: input.template.acl,
    rawPayload: draft.rawPayload,
    changeId: `${sourceSystem}-${objectType}-${changeType}-${sequence}`,
    changeType,
    changeSequence: sequence,
    changeOccurredAt: input.changeOccurredAt,
    correlation: {
      scenarioId: input.scenario.id,
      eventId: input.event.id,
      templateId: input.template.id,
      seedFingerprint: "test-seed",
    },
  };
  if (changeType !== "created") record.updatedAt = input.changeOccurredAt;
  return {
    ledgerSequence: sequence,
    worldRevision: "test-world",
    changeId: record.changeId,
    changeType,
    sourceSystem,
    sourceId: input.sourceId,
    changeOccurredAt: input.changeOccurredAt,
    sourceOccurredAt: input.occurredAt,
    scenarioId: input.scenario.id,
    scenarioPackId: input.scenario.id,
    scenarioInstanceId: input.state.scenarioInstanceId,
    businessEventId: input.event.id,
    templateId: input.template.id,
    record,
    permissionScope: input.template.acl,
  };
}

function gmailHeader(payload: Record<string, unknown>, name: string): string | undefined {
  const part = payload.payload as { headers?: Array<{ name: string; value: string }> };
  return part.headers?.find((header) => header.name === name)?.value;
}

function recordWithoutDeletionOuterFields(record: SourceRecord): Record<string, unknown> {
  const stableRecord: Record<string, unknown> = { ...record };
  delete stableRecord.changeId;
  delete stableRecord.changeType;
  delete stableRecord.changeSequence;
  delete stableRecord.changeOccurredAt;
  return stableRecord;
}

function cloneDefaultOrganizationConfig() {
  return JSON.parse(JSON.stringify(defaultOrganizationConfig));
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  callback: () => T | Promise<T>,
): Promise<T> {
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
  const sqlite = require("node:sqlite") as {
    DatabaseSync: new (filename: string) => TestSQLiteDatabase;
  };
  return new sqlite.DatabaseSync(filename);
}

function durableTableSql(database: TestSQLiteDatabase): Record<string, string> {
  const rows = database
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ORDER BY name",
    )
    .all(
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

function addMinutesIso(start: string, minutes: number): string {
  return new Date(Date.parse(start) + minutes * 60_000).toISOString();
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

async function clockWorldSnapshot(simulator: SourceSimulator) {
  return {
    ...(await storageWorldSnapshot(simulator)),
    clockStatus: await simulator.clockStatus(),
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
    const productIc = simulator
      .people()
      .find((person) => person.roleTemplateId === "role-product-ic");
    const productVp = simulator
      .people()
      .find((person) => person.roleTemplateId === "role-product-vp");
    expect(productIc?.managerId).toEqual(expect.any(String));
    expect(productVp?.managerId).toBeNull();
    expect(productVp?.directReportIds.length).toBeGreaterThan(0);

    const icRecords = (await simulator.recordsForPerson(productIc!.id)).records;
    const vpRecords = (await simulator.recordsForPerson(productVp!.id)).records;
    expect(icRecords.some((record) => record.title === "Launch date question for staff")).toBe(
      false,
    );
    expect(vpRecords.some((record) => record.title === "Launch date question for staff")).toBe(
      true,
    );
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
    expect(second.records.map((record) => record.changeId)).toEqual(
      retry.records.map((record) => record.changeId),
    );
    expect(
      new Set([...first.records, ...second.records].map((record) => record.changeId)).size,
    ).toBe(4);
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

    await expect(simulator.feed("conn-product-manager", first.nextCursor, 10)).rejects.toThrow(
      "Stale checkpoint",
    );
  });

  it("continues from a saved change checkpoint after new creates and updates", async () => {
    const simulator = await SourceSimulator.create({
      seed: "checkpoint-seed",
      baseUrl: "http://sim.test",
    });
    const initial = await simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initial.nextCursor;
    const initiallyConsumed = new Set(initial.records.map((record) => record.changeId));

    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const createdPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(
      retryCreatedPage.records.map((record) => record.changeId),
    );
    expect(createdPage.records.every((record) => !initiallyConsumed.has(record.changeId))).toBe(
      true,
    );

    const createdDependency = createdPage.records.find(
      (record) => record.title === "Workflow export API dependency",
    );
    expect(createdDependency?.changeType).toBe("created");

    await simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    const updatedPage = await simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find(
      (record) => record.sourceId === createdDependency?.sourceId,
    );
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);

    const allChangeIds = [...initial.records, ...createdPage.records, ...updatedPage.records].map(
      (record) => record.changeId,
    );
    expect(new Set(allChangeIds).size).toBe(allChangeIds.length);
    expect(
      (await simulator.feed("conn-product-manager", updatedPage.nextCursor, 100)).records,
    ).toEqual([]);
  });

  it("keeps same-pack scenario instances independent across advance, trigger, pause, reset, delete, and recreate", async () => {
    const simulator = await SourceSimulator.create({
      seed: "instance-independence-seed",
      baseUrl: "http://sim.test",
    });
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
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).not.toBe(
      bInitial.currentTime,
    );
    expect((await simulator.scenarioInstance("independent-b")).state.currentTime).toBe(
      bInitial.currentTime,
    );

    await simulator.triggerScenarioInstanceEvent("independent-a", "exec-pressure");
    expect((await simulator.scenarioInstance("independent-a")).state.triggeredEventIds).toContain(
      "exec-pressure",
    );
    expect(
      (await simulator.scenarioInstance("independent-b")).state.triggeredEventIds,
    ).not.toContain("exec-pressure");

    await simulator.pauseScenarioInstance("independent-a");
    const pausedA = (await simulator.scenarioInstance("independent-a")).state;
    await simulator.advanceScenarioInstance("independent-a", { hours: 12 });
    await simulator.advanceScenarioInstance("independent-b", { hours: 8 });
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).toBe(
      pausedA.currentTime,
    );
    expect((await simulator.scenarioInstance("independent-b")).state.currentTime).not.toBe(
      bInitial.currentTime,
    );

    const bBeforeReset = (await simulator.scenarioInstance("independent-b")).state;
    await simulator.resetScenarioInstance("independent-a", { seed: "instance-a-reset-seed" });
    expect((await simulator.scenarioInstance("independent-a")).state.currentTime).not.toBe(
      pausedA.currentTime,
    );
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);

    await simulator.deleteScenarioInstance("independent-a");
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);
    await expect(simulator.scenarioInstance("independent-a")).rejects.toThrow(
      "Unknown scenario instance",
    );

    await simulator.createScenarioInstance({
      scenarioPackId: "product-launch-readiness",
      scenarioInstanceId: "independent-a",
      seed: "instance-a-recreated-seed",
      account: "Alpha Medical",
    });
    expect((await simulator.scenarioInstance("independent-b")).state).toEqual(bBeforeReset);
    expect((await simulator.scenarioInstance("independent-a")).state.seed).toBe(
      "instance-a-recreated-seed",
    );
  });

  it("keeps the ledger occurred-only and appends new creates and updates after a saved cursor", async () => {
    const simulator = await SourceSimulator.create({
      seed: "occurred-ledger-seed",
      baseUrl: "http://sim.test",
    });
    const initialWorldRevision = (await simulator.datasetMetadata()).worldRevision;
    const initialChanges = await simulator.sourceChanges();
    expect(
      initialChanges.some((change) => change.record.title === "Workflow export API dependency"),
    ).toBe(false);
    expect(initialChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(true);

    const initialPage = await simulator.feed("conn-product-manager", undefined, 100);
    const initialCheckpoint = initialPage.nextCursor;
    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    expect((await simulator.datasetMetadata()).worldRevision).toBe(initialWorldRevision);

    const afterCreateChanges = await simulator.sourceChanges();
    expect(
      afterCreateChanges.slice(0, initialChanges.length).map((change) => change.changeId),
    ).toEqual(initialChanges.map((change) => change.changeId));
    expect(afterCreateChanges.every((change, index) => change.ledgerSequence === index + 1)).toBe(
      true,
    );
    expect(new Set(afterCreateChanges.map((change) => change.changeId)).size).toBe(
      afterCreateChanges.length,
    );

    const createdPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    const retryCreatedPage = await simulator.feed("conn-product-manager", initialCheckpoint, 100);
    expect(createdPage.records.map((record) => record.changeId)).toEqual(
      retryCreatedPage.records.map((record) => record.changeId),
    );
    const productStateAfterCreate = await simulator.state("product-launch-readiness");
    expect(
      createdPage.records.every(
        (record) =>
          Date.parse(record.changeOccurredAt) <= Date.parse(productStateAfterCreate.currentTime),
      ),
    ).toBe(true);
    const createdDependency = createdPage.records.find(
      (record) => record.title === "Workflow export API dependency",
    );
    expect(createdDependency?.changeType).toBe("created");

    await simulator.advanceScenario("product-launch-readiness", { hours: 6 });
    expect((await simulator.datasetMetadata()).worldRevision).toBe(initialWorldRevision);
    const updatedPage = await simulator.feed("conn-product-manager", createdPage.nextCursor, 100);
    const updatedDependency = updatedPage.records.find(
      (record) => record.sourceId === createdDependency?.sourceId,
    );
    expect(updatedDependency?.changeType).toBe("updated");
    expect(updatedDependency?.sourceId).toBe(createdDependency?.sourceId);
  });

  it("uses current instance time for early manual triggers and delays updates from that occurrence time", async () => {
    const simulator = await SourceSimulator.create({
      seed: "manual-trigger-seed",
      baseUrl: "http://sim.test",
    });
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
    expect(
      triggeredPage.records.some(
        (record) =>
          record.title === "Launch date question for staff" && record.changeType === "created",
      ),
    ).toBe(true);
    expect(
      triggeredPage.records.some(
        (record) => record.title === "Launch decision update" && record.changeType === "created",
      ),
    ).toBe(true);
    expect(
      triggeredPage.records.some(
        (record) => record.title === "Launch decision update" && record.changeType === "updated",
      ),
    ).toBe(false);
    expect(
      (await simulator.sourceChanges()).some(
        (change) =>
          change.scenarioInstanceId === "manual-trigger-a" &&
          change.record.title === "Launch decision update" &&
          change.changeType === "updated",
      ),
    ).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-a", { hours: 7 });
    expect(
      (await simulator.sourceChanges()).some(
        (change) =>
          change.scenarioInstanceId === "manual-trigger-a" &&
          change.record.title === "Launch decision update" &&
          change.changeType === "updated",
      ),
    ).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-a", { hours: 1 });
    const updatedChange = (await simulator.sourceChanges()).find(
      (change) =>
        change.scenarioInstanceId === "manual-trigger-a" &&
        change.record.title === "Launch decision update" &&
        change.changeType === "updated",
    );
    expect(updatedChange?.changeOccurredAt).toBe(addHoursIso(triggerTime, 8));
    expect(updatedChange?.record.updatedAt).toBe(addHoursIso(triggerTime, 8));

    const changeCountBeforeRetry = (await simulator.sourceChanges()).length;
    await simulator.triggerScenarioInstanceEvent("manual-trigger-a", "exec-pressure");
    const afterRetry = (await simulator.scenarioInstance("manual-trigger-a")).state;
    expect(afterRetry.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(afterRetry.eventLog.filter((entry) => entry.eventId === "exec-pressure")).toHaveLength(
      1,
    );
    expect(await simulator.sourceChanges()).toHaveLength(changeCountBeforeRetry);

    const peer = (await simulator.scenarioInstance("manual-trigger-b")).state;
    expect(peer.triggeredEventIds).not.toContain("exec-pressure");
    expect(peer.eventOccurrenceTimes["exec-pressure"]).toBeUndefined();
    expect(peer.eventLog.some((entry) => entry.eventId === "exec-pressure")).toBe(false);

    await simulator.advanceScenarioInstance("manual-trigger-b", { hours: 30 });
    const peerAfterAdvance = (await simulator.scenarioInstance("manual-trigger-b")).state;
    expect(
      peerAfterAdvance.eventLog.find((entry) => entry.eventId === "dependency-risk")?.occurredAt,
    ).toBe(addHoursIso(peer.startedAt, 24));
    expect(peerAfterAdvance.currentTime).toBe(addHoursIso(peer.startedAt, 30));
  });

  it("calculates manual-trigger deletions from actual trigger time", async () => {
    const simulator = await SourceSimulator.create({
      seed: "manual-delete-seed",
      baseUrl: "http://sim.test",
    });
    const beforeTrigger = await simulator.state("technical-debt-staffing-risk");
    const triggerTime = beforeTrigger.currentTime;
    expect(triggerTime).not.toBe(addHoursIso(beforeTrigger.startedAt, 80));

    await simulator.triggerScenarioEvent("technical-debt-staffing-risk", "vp-investment");
    const created = (await simulator.sourceChanges()).find(
      (change) =>
        change.record.title === "Deferred retry remediation item" &&
        change.changeType === "created",
    );
    expect(created?.changeOccurredAt).toBe(triggerTime);
    expect(
      (await simulator.sourceChanges()).some(
        (change) =>
          change.record.title === "Deferred retry remediation item" &&
          change.changeType === "deleted",
      ),
    ).toBe(false);

    await simulator.advanceScenario("technical-debt-staffing-risk", { hours: 35 });
    expect(
      (await simulator.sourceChanges()).some(
        (change) =>
          change.record.title === "Deferred retry remediation item" &&
          change.changeType === "deleted",
      ),
    ).toBe(false);

    await simulator.advanceScenario("technical-debt-staffing-risk", { hours: 1 });
    const deleted = (await simulator.sourceChanges()).find(
      (change) =>
        change.record.title === "Deferred retry remediation item" &&
        change.changeType === "deleted",
    );
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

    expect(
      productIc.records.some((record) => record.title === "Launch date question for staff"),
    ).toBe(false);
    expect(
      productManager.records.some((record) => record.title === "Launch date question for staff"),
    ).toBe(false);
    expect(
      productDirector.records.some((record) => record.title === "Launch date question for staff"),
    ).toBe(false);
    expect(
      productVp.records.some((record) => record.title === "Launch date question for staff"),
    ).toBe(true);
  });

  it("keeps cross-department source access permission-scoped", async () => {
    const simulator = await advancedSimulator();
    const productManager = await simulator.feed("conn-product-manager", undefined, 100);
    const customerSuccessManager = await simulator.feed(
      "conn-customer-success-manager",
      undefined,
      100,
    );

    expect(
      productManager.records.some((record) => record.title === "Workflow export API dependency"),
    ).toBe(true);
    expect(
      customerSuccessManager.records.some(
        (record) => record.title === "Workflow export API dependency",
      ),
    ).toBe(false);
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
    const before = (await simulator.feed("conn-engineering-manager", undefined, 100)).records.map(
      (record) => record.sourceId,
    );

    await simulator.advanceScenario("reliability-incident", { hours: 30 });
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const after = (await simulator.feed("conn-engineering-manager", undefined, 100)).records.map(
      (record) => record.sourceId,
    );

    expect(after).toEqual(before);
  });

  it("restores multiple scenario instances independently and rebuilds a deterministic ledger under a new revision", async () => {
    const simulator = await SourceSimulator.create({
      seed: "snapshot-instance-seed",
      baseUrl: "http://sim.test",
    });
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
    const cursorBeforeRestore = (await simulator.feed("conn-product-manager", undefined, 100))
      .nextCursor;
    const revisionBeforeRestore = (await simulator.datasetMetadata()).worldRevision;

    await simulator.advanceScenarioInstance("snapshot-a", { hours: 30 });
    await simulator.triggerScenarioInstanceEvent("snapshot-b", "exec-pressure");
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const firstRestoreRevision = (await simulator.datasetMetadata()).worldRevision;
    const firstRestoreLedger = (await simulator.sourceChanges()).map((change) => ({
      ...change,
      worldRevision: "<ignored>",
    }));

    expect(firstRestoreRevision).not.toBe(revisionBeforeRestore);
    await expect(simulator.feed("conn-product-manager", cursorBeforeRestore, 100)).rejects.toThrow(
      "Stale checkpoint",
    );
    expect((await simulator.scenarioInstance("snapshot-a")).state).toEqual(aAtSnapshot);
    expect((await simulator.scenarioInstance("snapshot-b")).state).toEqual(bAtSnapshot);

    await simulator.advanceScenarioInstance("snapshot-a", { hours: 1 });
    await simulator.restoreSnapshot(snapshot.snapshotId);
    const secondRestoreLedger = (await simulator.sourceChanges()).map((change) => ({
      ...change,
      worldRevision: "<ignored>",
    }));
    expect(secondRestoreLedger).toEqual(firstRestoreLedger);
  });

  it("does not expose source updates before the simulation clock reaches the update time", async () => {
    const simulator = await SourceSimulator.create({
      seed: "temporal-seed",
      baseUrl: "http://sim.test",
    });

    expect(
      (await simulator.feed("conn-product-manager", undefined, 100)).records.some(
        (record) => record.title === "Workflow export API dependency",
      ),
    ).toBe(false);

    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const created = (await simulator.allRecords()).find(
      (record) => record.title === "Workflow export API dependency",
    );
    expect(created).toBeDefined();
    expect(created?.updatedAt).toBeUndefined();
    expect(created?.changeType).toBe("created");
    expect(assertNoSimulatorMetadata(created?.rawPayload).ok).toBe(true);

    await simulator.advanceScenario("product-launch-readiness", { hours: 5 });
    const beforeUpdate = (await simulator.allRecords()).find(
      (record) => record.sourceId === created?.sourceId,
    );
    expect(beforeUpdate?.updatedAt).toBeUndefined();

    await simulator.advanceScenario("product-launch-readiness", { hours: 1 });
    const updated = (await simulator.allRecords()).find(
      (record) => record.sourceId === created?.sourceId,
    );
    expect(updated?.sourceId).toBe(created?.sourceId);
    expect(updated?.updatedAt).toBe("2026-07-11T22:00:00.000Z");
    expect(updated?.changeType).toBe("updated");
    expect(assertNoSimulatorMetadata(updated?.rawPayload).ok).toBe(true);
  });

  it("emits timeline mutations as source-object versions with stable identity", async () => {
    const simulator = await SourceSimulator.create({
      seed: "feed-update-seed",
      baseUrl: "http://sim.test",
    });
    await simulator.advanceScenario("reliability-incident", { hours: 5 });
    const initialPage = await simulator.feed("conn-engineering-manager", undefined, 100);
    const initial = initialPage.records.find(
      (record) => record.title === "Throttle connector retries under queue pressure",
    );
    expect(initial?.updatedAt).toBeUndefined();
    expect(initial?.changeType).toBe("created");

    await simulator.advanceScenario("reliability-incident", { hours: 3 });
    const afterUpdate = (
      await simulator.feed("conn-engineering-manager", initialPage.nextCursor, 100)
    ).records.find((record) => record.sourceId === initial?.sourceId);
    expect(afterUpdate?.sourceId).toBe(initial?.sourceId);
    expect(afterUpdate?.updatedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(afterUpdate?.changeType).toBe("updated");
  });

  it("preserves source identity across created, updated, and deleted history entries", async () => {
    const simulator = await completedDatasetSimulator("history-seed", "small");
    const deletedChange = (await simulator.sourceChanges()).find(
      (change) =>
        change.record.title === "Deferred retry remediation item" &&
        change.changeType === "deleted",
    );
    expect(deletedChange).toBeDefined();

    const history = await simulator.sourceObjectHistory(
      deletedChange!.sourceSystem,
      deletedChange!.sourceId,
    );
    expect(history.map((change) => change.sourceId)).toEqual(
      history.map(() => deletedChange!.sourceId),
    );
    expect(history.map((change) => change.changeType)).toEqual(["created", "deleted"]);
  });
});

describe("Milestone 2 scenario packs and adapters", () => {
  it("registers all required source adapters and validates emitted vendor payloads", async () => {
    const simulator = await completedDatasetSimulator("adapter-seed", "small");
    expect(sourceAdapters.map((adapter) => adapter.sourceSystem).sort()).toEqual(
      [...sourceSystems].sort(),
    );

    for (const adapter of sourceAdapters) {
      const changes = (await simulator.sourceChanges()).filter(
        (candidate) => candidate.sourceSystem === adapter.sourceSystem,
      );
      const change = changes[0];
      expect(change, adapter.sourceSystem).toBeDefined();
      for (const sourceChange of changes) {
        expect(
          adapter.validatePayload(sourceChange.record.rawPayload, sourceChange.record.objectType),
          `${adapter.sourceSystem}:${sourceChange.record.objectType}`,
        ).toEqual({
          ok: true,
          errors: [],
        });
        expect(
          assertNoSimulatorMetadata(sourceChange.record.rawPayload),
          `${adapter.sourceSystem}:${sourceChange.record.title}`,
        ).toEqual({ ok: true, errors: [] });
        expect(sourceChange.record.actorRef).toEqual(expect.any(String));
      }
      expect(adapter.buildSourceUrl({ baseUrl: "http://sim.test", sourceId: "source-123" })).toBe(
        `http://sim.test/sim/${adapter.sourceSystem}/source-123`,
      );
    }
  });

  it("documents official source contracts and rejects wrong-provider payloads", async () => {
    expect(sourceContractManifests.map((manifest) => manifest.sourceSystem).sort()).toEqual(
      [...sourceSystems].sort(),
    );
    for (const manifest of sourceContractManifests) {
      expect(manifest.contractVersion).toBe(SOURCE_PAYLOAD_CONTRACT_VERSION);
      expect(manifest.docs.length).toBeGreaterThan(0);
      expect(manifest.families.length).toBeGreaterThan(0);
      for (const url of manifest.docs) expect(url).toMatch(/^https:\/\//);
    }

    const simulator = await completedDatasetSimulator("cross-provider-seed", "small");
    const slackRecord = (await simulator.sourceChanges()).find(
      (change) => change.sourceSystem === "slack",
    )!.record;
    const zendeskRecord = (await simulator.sourceChanges()).find(
      (change) => change.sourceSystem === "zendesk",
    )!.record;

    expect(validateVendorPayload("slack", slackRecord.objectType, slackRecord.rawPayload).ok).toBe(
      true,
    );
    expect(validateVendorPayload("gmail", "message", slackRecord.rawPayload).ok).toBe(false);
    expect(
      validateVendorPayload("zendesk", zendeskRecord.objectType, {
        ...zendeskRecord.rawPayload,
        status: "deleted",
      }).ok,
    ).toBe(false);
    expect(
      validateVendorPayload("slack", slackRecord.objectType, {
        ...slackRecord.rawPayload,
        provider: "slack",
      }).ok,
    ).toBe(false);
  });

  it("validates official-document-derived fixtures for every canonical payload family", async () => {
    const fixtures = await loadVendorPayloadFixtures();
    const expectedKeys = sourceSystems
      .flatMap((sourceSystem) =>
        canonicalVendorPayloadFamilies[sourceSystem].map((family) => `${sourceSystem}:${family}`),
      )
      .sort();
    const fixtureKeys = fixtures
      .map((fixture) => `${fixture.sourceSystem}:${fixture.family}`)
      .sort();
    expect(fixtureKeys).toEqual(expectedKeys);

    for (const fixture of fixtures) {
      expect(fixture.provenanceUrl, `${fixture.sourceSystem}:${fixture.family}`).toMatch(
        /^https:\/\//,
      );
      expect(
        validateVendorPayload(fixture.sourceSystem, fixture.family, fixture.payload),
        `${fixture.sourceSystem}:${fixture.family}`,
      ).toEqual({ ok: true, errors: [] });
      expect(
        assertNoSimulatorMetadata(fixture.payload),
        `${fixture.sourceSystem}:${fixture.family}`,
      ).toEqual({ ok: true, errors: [] });
    }
  });

  it("keeps adapter, manifest, schema, and generated payload families in parity", async () => {
    const simulator = await completedDatasetSimulator("family-parity-seed", "small");
    const changes = await simulator.sourceChanges();

    for (const sourceSystem of sourceSystems) {
      const adapter = sourceAdapters.find((candidate) => candidate.sourceSystem === sourceSystem)!;
      const manifest = sourceContractManifests.find(
        (candidate) => candidate.sourceSystem === sourceSystem,
      )!;
      const expectedFamilies = [...canonicalVendorPayloadFamilies[sourceSystem]].sort();
      const adapterFamilies = [
        ...new Set(
          adapter.supportedObjectTypes.map((objectType) =>
            canonicalPayloadFamily(sourceSystem, objectType),
          ),
        ),
      ].sort();
      const manifestFamilies = manifest.families.map((family) => family.family).sort();
      const schemaFamilies = Object.keys(vendorPayloadSchemas[sourceSystem])
        .filter((family) => expectedFamilies.includes(canonicalPayloadFamily(sourceSystem, family)))
        .map((family) => canonicalPayloadFamily(sourceSystem, family));
      const generatedFamilies = [
        ...new Set(
          changes
            .filter((change) => change.sourceSystem === sourceSystem)
            .map((change) => change.record.objectType),
        ),
      ].sort();

      expect(adapterFamilies, `${sourceSystem} adapter families`).toEqual(expectedFamilies);
      expect(manifestFamilies, `${sourceSystem} manifest families`).toEqual(expectedFamilies);
      expect([...new Set(schemaFamilies)].sort(), `${sourceSystem} schema families`).toEqual(
        expectedFamilies,
      );
      expect(generatedFamilies, `${sourceSystem} generated families`).toEqual(expectedFamilies);
    }
  });

  it("rejects cross-family payloads within multi-family providers", async () => {
    const simulator = await completedDatasetSimulator("family-rejection-seed", "small");
    const bySource = recordsBySourceAndFamily(await simulator.sourceChanges());

    for (const [sourceSystem, expectedFamilies] of Object.entries(
      canonicalVendorPayloadFamilies,
    ) as Array<[SourceSystem, string[]]>) {
      if (expectedFamilies.length < 2) continue;
      for (const family of expectedFamilies) {
        const record = bySource.get(`${sourceSystem}:${family}`);
        expect(record, `${sourceSystem}:${family}`).toBeDefined();
        for (const otherFamily of expectedFamilies.filter((candidate) => candidate !== family)) {
          expect(
            validateVendorPayload(sourceSystem, otherFamily, record!.rawPayload).ok,
            `${sourceSystem}:${family} should not validate as ${otherFamily}`,
          ).toBe(false);
        }
      }
    }
  });

  it("preserves deliberate legacy-to-provider family mappings", async () => {
    expect(canonicalPayloadFamily("gmail", "email")).toBe("message");
    expect(canonicalPayloadFamily("calendar", "meeting")).toBe("event");
    expect(canonicalPayloadFamily("notion", "decision_log")).toBe("page");
    expect(canonicalPayloadFamily("jira", "bug")).toBe("issue");
    expect(canonicalPayloadFamily("productboard", "insight")).toBe("note");
    expect(canonicalPayloadFamily("productboard", "textNote")).toBe("note");
    expect(canonicalPayloadFamily("amplitude", "metric_snapshot")).toBe("chart_response");
    expect(canonicalPayloadFamily("salesforce", "opportunity_update")).toBe("Opportunity");
    expect(canonicalPayloadFamily("salesforce", "activity")).toBe("Task");
    expect(canonicalPayloadFamily("gainsight", "milestone")).toBe("TimelineActivity");
  });

  it("keeps provider lifecycle fields distinct from normalized simulator changes", async () => {
    const simulator = await completedDatasetSimulator("provider-lifecycle-seed", "small");
    const changes = await simulator.sourceChanges();
    const jiraDeleted = changes.find(
      (change) =>
        change.sourceSystem === "jira" &&
        change.changeType === "deleted" &&
        change.record.title === "Deferred retry remediation item",
    )!;
    const jiraFields = jiraDeleted.record.rawPayload.fields as Record<string, unknown>;
    const jiraStatus = jiraFields.status as Record<string, unknown>;
    expect(jiraDeleted.changeType).toBe("deleted");
    expect(jiraStatus.name).toBe("Deferred");
    expect(jiraStatus.name).not.toBe("Done");

    const amplitudeRecord = changes.find((change) => change.sourceSystem === "amplitude")!.record;
    expect(Object.keys(amplitudeRecord.rawPayload).sort()).toEqual(["data"]);

    const productboardFeature = recordsBySourceAndFamily(changes).get("productboard:feature")!;
    const productboardPayload = productboardFeature.rawPayload as Record<string, unknown>;
    const productboardData = productboardPayload.data as Record<string, unknown>;
    const productboardFields = productboardData.fields as Record<string, unknown>;
    expect(
      validateVendorPayload("productboard", "feature", {
        ...productboardPayload,
        data: {
          ...productboardData,
          fields: { ...productboardFields, product_area: "Invented field" },
        },
      }).ok,
    ).toBe(false);

    const gmailAdapter = sourceAdapters.find((adapter) => adapter.sourceSystem === "gmail")!;
    const gmailTrashInput = emissionInput("gmail", "email", { changeType: "updated" });
    gmailTrashInput.template.rawPayload = { trash: true };
    const gmailTrash = gmailAdapter.update(gmailTrashInput);
    expect(gmailTrash.objectType).toBe("message");
    expect(gmailTrash.rawPayload.labelIds).toContain("TRASH");
    expect(gmailTrash.rawPayload.labelIds).not.toContain("INBOX");

    const gmailPermanentDelete = gmailAdapter.remove(
      emissionInput("gmail", "email", { changeType: "deleted" }),
    );
    expect(gmailPermanentDelete.objectType).toBe("message");
    expect(gmailPermanentDelete.rawPayload.labelIds).not.toContain("TRASH");

    const productboardAdapter = sourceAdapters.find(
      (adapter) => adapter.sourceSystem === "productboard",
    )!;
    for (const noteAlias of ["insight", "note", "textNote"]) {
      const productboardNote = productboardAdapter.create(
        emissionInput("productboard", noteAlias, { changeType: "created" }),
      );
      expect(productboardNote.objectType, noteAlias).toBe("note");
      expect((productboardNote.rawPayload.data as Record<string, unknown>).type).toBe("textNote");
    }
    const productboardArchiveInput = emissionInput("productboard", "feature", {
      changeType: "updated",
    });
    productboardArchiveInput.template.rawPayload = { archived: true };
    const productboardArchive = productboardAdapter.update(productboardArchiveInput);
    expect(
      (
        ((productboardArchive.rawPayload.data as Record<string, unknown>).fields ?? {}) as Record<
          string,
          unknown
        >
      ).archived,
    ).toBe(true);

    const productboardDelete = productboardAdapter.remove(
      emissionInput("productboard", "feature", { changeType: "deleted" }),
    );
    expect(
      (
        ((productboardDelete.rawPayload.data as Record<string, unknown>).fields ?? {}) as Record<
          string,
          unknown
        >
      ).archived,
    ).toBe(false);

    const slackDelete = sourceAdapters
      .find((adapter) => adapter.sourceSystem === "slack")!
      .remove(emissionInput("slack", "message"));
    const slackPayload = slackDelete.rawPayload;
    expect(slackPayload.subtype).toBe("message_deleted");
    expect(slackPayload.deleted_ts).toBe(slackPayload.ts);
    expect(slackPayload.event_ts).not.toBe(slackPayload.deleted_ts);

    const githubAdapter = sourceAdapters.find((adapter) => adapter.sourceSystem === "github")!;
    const githubCreateInput = emissionInput("github", "pull_request", { changeType: "created" });
    githubCreateInput.template.rawPayload = { updatedStatus: "merged" };
    const githubCreate = githubAdapter.create(githubCreateInput);
    expect(githubCreate.objectType).toBe("pull_request");
    expect(githubCreate.rawPayload.state).toBe("open");
    expect(githubCreate.rawPayload.merged).toBe(false);

    const githubDelete = githubAdapter.remove(emissionInput("github", "issue"));
    expect(githubDelete.objectType).toBe("issue");
    expect(githubDelete.rawPayload.state).toBe("open");
    expect(githubDelete.rawPayload.closed_at).toBeNull();

    const githubReleaseDelete = githubAdapter.remove(
      emissionInput("github", "release", { changeType: "deleted" }),
    );
    expect(githubReleaseDelete.objectType).toBe("release");
    expect(githubReleaseDelete.rawPayload.draft).toBe(false);
    expect(githubReleaseDelete.rawPayload.published_at).toBe("2026-07-10T00:00:00.000Z");
  });

  it("keeps Gmail message identity and message-date fields stable across label updates and trash", async () => {
    const created = adapterDraft("gmail", "email", "created").draft.rawPayload;
    const labelUpdate = adapterDraft("gmail", "email", "updated").draft.rawPayload;
    const trashUpdate = adapterDraft("gmail", "email", "updated", { trash: true }).draft.rawPayload;

    for (const payload of [labelUpdate, trashUpdate]) {
      expect(payload.id).toBe(created.id);
      expect(payload.threadId).toBe(created.threadId);
      expect(payload.internalDate).toBe(created.internalDate);
      expect(gmailHeader(payload, "Date")).toBe(gmailHeader(created, "Date"));
      expect(gmailHeader(payload, "Message-ID")).toBe(gmailHeader(created, "Message-ID"));
      expect((payload.payload as Record<string, unknown>).body).toEqual(
        (created.payload as Record<string, unknown>).body,
      );
    }
    expect(labelUpdate.labelIds).toContain("IMPORTANT");
    expect(labelUpdate.labelIds).not.toContain("TRASH");
    expect(trashUpdate.labelIds).toContain("TRASH");
    expect(trashUpdate.labelIds).not.toContain("INBOX");
  });

  it("preserves last-known payloads for provider delete operations that return no body", async () => {
    const gmailCreated = ledgerChangeForDraft("gmail", "email", "created", 1);
    const gmailTrashed = ledgerChangeForDraft("gmail", "email", "updated", 2, { trash: true });
    const gmailDeleted = ledgerChangeForDraft("gmail", "email", "deleted", 3);
    const productboardCreated = ledgerChangeForDraft("productboard", "feature", "created", 4);
    const productboardArchived = ledgerChangeForDraft("productboard", "feature", "updated", 5, {
      archived: true,
    });
    const productboardDeleted = ledgerChangeForDraft("productboard", "feature", "deleted", 6);
    const releaseCreated = ledgerChangeForDraft("github", "release", "created", 7);
    const releaseDeleted = ledgerChangeForDraft("github", "release", "deleted", 8);

    const preserved = preserveNoBodyDeletionPayloads([
      gmailCreated,
      gmailTrashed,
      gmailDeleted,
      productboardCreated,
      productboardArchived,
      productboardDeleted,
      releaseCreated,
      releaseDeleted,
    ]);
    const preservedGmailDelete = preserved[2]!;
    const preservedProductboardDelete = preserved[5]!;
    const preservedReleaseDelete = preserved[7]!;

    expect(preservedGmailDelete.record.rawPayload).toEqual(gmailTrashed.record.rawPayload);
    expect(preservedProductboardDelete.record.rawPayload).toEqual(
      productboardArchived.record.rawPayload,
    );
    expect(preservedReleaseDelete.record.rawPayload).toEqual(releaseCreated.record.rawPayload);

    expect(recordWithoutDeletionOuterFields(preservedGmailDelete.record)).toEqual(
      recordWithoutDeletionOuterFields(gmailTrashed.record),
    );
    expect(recordWithoutDeletionOuterFields(preservedProductboardDelete.record)).toEqual(
      recordWithoutDeletionOuterFields(productboardArchived.record),
    );
    expect(recordWithoutDeletionOuterFields(preservedReleaseDelete.record)).toEqual(
      recordWithoutDeletionOuterFields(releaseCreated.record),
    );
    for (const deletion of [
      preservedGmailDelete,
      preservedProductboardDelete,
      preservedReleaseDelete,
    ]) {
      expect(deletion.changeType).toBe("deleted");
      expect(deletion.record.changeType).toBe("deleted");
      expect(deletion.changeOccurredAt).toBe("2026-07-10T04:00:00.000Z");
      expect(deletion.record.changeOccurredAt).toBe("2026-07-10T04:00:00.000Z");
    }
  });

  it("validates create, update, and delete drafts for every declared adapter object type", async () => {
    for (const adapter of sourceAdapters) {
      for (const objectType of adapter.supportedObjectTypes) {
        for (const [changeType, method] of [
          ["created", "create"],
          ["updated", "update"],
          ["deleted", "remove"],
        ] as const) {
          const input = emissionInput(adapter.sourceSystem, objectType, { changeType });
          const draft = adapter[method](input);
          const expectedFamily = canonicalPayloadFamily(adapter.sourceSystem, objectType);
          expect(draft.objectType, `${adapter.sourceSystem}:${objectType}:${changeType}`).toBe(
            expectedFamily,
          );
          expect(
            adapter.validatePayload(draft.rawPayload, draft.objectType),
            `${adapter.sourceSystem}:${objectType}:${changeType}`,
          ).toEqual({ ok: true, errors: [] });
        }
      }
    }
  });

  it("validates create, update, and delete drafts for every canonical provider family", async () => {
    for (const sourceSystem of sourceSystems) {
      const adapter = sourceAdapters.find((candidate) => candidate.sourceSystem === sourceSystem)!;
      for (const family of canonicalVendorPayloadFamilies[sourceSystem]) {
        const objectType = representativeObjectType(sourceSystem, family);
        for (const [changeType, method] of [
          ["created", "create"],
          ["updated", "update"],
          ["deleted", "remove"],
        ] as const) {
          const input = emissionInput(sourceSystem, objectType, { changeType });
          const draft = adapter[method](input);
          expect(draft.objectType, `${sourceSystem}:${family}:${changeType}`).toBe(family);
          expect(
            adapter.validatePayload(draft.rawPayload, draft.objectType),
            `${sourceSystem}:${family}:${changeType}`,
          ).toEqual({ ok: true, errors: [] });
        }
      }
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
    expect(simulator.organizationSummary().counts.byRoleLevel).toMatchObject({
      ic: expect.any(Number),
      manager: expect.any(Number),
      director: expect.any(Number),
      vp: expect.any(Number),
    });
    expect([...unionRoles].length).toBeGreaterThan(0);
  });

  it("generates deterministic dataset sizes inside documented change-count ranges", async () => {
    const small = await (
      await completedDatasetSimulator("dataset-seed", "small")
    ).datasetMetadata();
    const medium = await (
      await completedDatasetSimulator("dataset-seed", "medium")
    ).datasetMetadata();
    const mediumReplay = await (
      await completedDatasetSimulator("dataset-seed", "medium")
    ).datasetMetadata();
    const large = await (
      await completedDatasetSimulator("dataset-seed", "large")
    ).datasetMetadata();

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
    const dotted = relationships.filter(
      (relationship) => relationship.relationshipType === "dotted_line",
    );
    const primary = relationships.filter(
      (relationship) => relationship.relationshipType === "primary",
    );
    const peopleById = new Map(simulator.people().map((person) => [person.id, person]));

    expect(dotted.length).toBeGreaterThanOrEqual(2);
    for (const relationship of dotted) {
      expect(peopleById.get(relationship.reportId)?.managerId).not.toBe(relationship.managerId);
    }
    for (const person of simulator.people().filter((candidate) => candidate.managerId)) {
      expect(primary.filter((relationship) => relationship.reportId === person.id)).toHaveLength(1);
    }
    expect(
      simulator
        .teams()
        .some((team) => team.id === "team-project-aurora" && team.level === "project"),
    ).toBe(true);
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
        {
          SIMULATOR_STORAGE_DRIVER: "sqlite",
          SIMULATOR_ALLOW_EPHEMERAL_MEMORY: undefined,
          DATABASE_URL: undefined,
        },
        () =>
          createApp({
            runtimeEnv: "preview",
            adminKey: "prod-admin",
            connectionCredentials: productionCredentials,
          }),
      ),
    ).rejects.toThrow(/SQLite storage is forbidden/);
    await expect(
      withEnv(
        {
          SIMULATOR_STORAGE_DRIVER: "memory",
          SIMULATOR_ALLOW_EPHEMERAL_MEMORY: "true",
          DATABASE_URL: undefined,
        },
        () =>
          createApp({
            runtimeEnv: "production",
            adminKey: "prod-admin",
            connectionCredentials: productionCredentials,
          }),
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

    const injectedSimulator = await SourceSimulator.create({
      storage: new MemorySimulatorStorage(),
    });
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
    const simulator = await SourceSimulator.create({
      seed: "regen-auth-seed",
      baseUrl: "http://sim.test",
    });
    const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
    const removedPerson = simulator
      .people()
      .find((person) => person.stableKey === "product:ic:v1:d1:m1:i4");
    expect(removedPerson).toBeDefined();
    const removedConnectionId = personConnectionId(removedPerson!);

    const before = await app.request(`/v1/connections/${removedConnectionId}/manifest`, {
      headers: developmentConnectionHeaders(removedConnectionId),
    });
    expect(before.status).toBe(200);

    const nextConfig = cloneDefaultOrganizationConfig();
    nextConfig.seed = "regen-auth-new-seed";
    nextConfig.departments.product = {
      vpCount: 1,
      directorsPerVp: 1,
      managersPerDirector: 1,
      icsPerManager: 1,
    };
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
            engineering: {
              vpCount: 3,
              directorsPerVp: 8,
              managersPerDirector: 10,
              icsPerManager: 25,
            },
            customer_success: {
              vpCount: 3,
              directorsPerVp: 8,
              managersPerDirector: 10,
              icsPerManager: 25,
            },
          },
        },
      }),
    });
    expect(tooLargeOrg.status).toBe(400);

    const tooLargePage = await app.request(
      "/v1/connections/conn-product-manager/records?limit=1000",
      {
        headers: connectionHeaders("secret-product-manager"),
      },
    );
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
    const incompatible = async (
      mutate: (config: ReturnType<typeof cloneDefaultOrganizationConfig>) => void,
    ) => {
      const config = cloneDefaultOrganizationConfig();
      config.seed = `incompatible-${incompatibleIndex++}`;
      mutate(config);
      const response = await requestConfig(config);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(
        /incompatible with enabled scenarios|missing required role/,
      );
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
    const badCursor = await app.request(
      "/v1/connections/conn-product-manager/records?cursor=not-base64",
      {
        headers: connectionHeaders("secret-product-manager"),
      },
    );
    expect(badCursor.status).toBe(400);

    const first = await app.request("/v1/connections/conn-product-manager/records?limit=1", {
      headers: connectionHeaders("secret-product-manager"),
    });
    const firstBody = await first.json();
    const crossed = await app.request(
      `/v1/connections/conn-product-ic/records?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      {
        headers: connectionHeaders("secret-product-ic"),
      },
    );
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

    const resolved = await app.request(link.pathname, {
      headers: connectionHeaders("secret-product-manager"),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).record.sourceId).toBe(record.sourceId);
  });

  it("fails safely for unknown and unauthorized source objects", async () => {
    const { app } = await credentialedApp();
    const vpFeed = await app.request("/v1/connections/conn-product-vp/records?limit=100", {
      headers: connectionHeaders("secret-product-vp"),
    });
    const execRecord = SourceFeedBatchV1Schema.parse(await vpFeed.json()).records.find(
      (record) => record.title === "Launch date question for staff",
    )!;
    const execLink = new URL(execRecord.sourceUrl);

    const unauthorized = await app.request(execLink.pathname, {
      headers: connectionHeaders("secret-product-ic"),
    });
    expect(unauthorized.status).toBe(403);

    const unknown = await app.request("/sim/slack/not-real", {
      headers: connectionHeaders("secret-product-manager"),
    });
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
    expect(
      (await requests.json()).requests.some(
        (request: { connectionId?: string }) => request.connectionId === "conn-product-manager",
      ),
    ).toBe(true);

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
      rateLimitConfigJson: JSON.stringify({
        enabled: true,
        windowMs: 60_000,
        adminLimit: 1,
        connectionLimit: 1,
      }),
    });

    expect(
      (
        await app.request("/v1/connections/conn-product-manager/manifest", {
          headers: connectionHeaders("secret-product-manager"),
        })
      ).status,
    ).toBe(200);
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
    expect(() =>
      assertBenchmarkDatabaseIsIsolated(
        "postgres://user:pass@localhost:5432/app?sslmode=disable",
        "postgres://user:pass@localhost:5432/app?sslmode=disable",
      ),
    ).toThrow(/separate from DATABASE_URL/);
    expect(() =>
      assertBenchmarkDatabaseIsIsolated(
        "postgres://user:pass@localhost:5432/app",
        "postgres://user:pass@localhost:5432/benchmark",
      ),
    ).not.toThrow();
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
    const manualReport = await simulator.reconcileSimulationClock({
      now: "2026-07-10T01:00:00.000Z",
    });
    expect(manualReport.simulationDeltaMs).toBe(0);
    expect((await simulator.state("product-launch-readiness")).currentTime).toBe(
      stateBefore.currentTime,
    );

    await simulator.updateClock(
      { mode: "realtime", speedMultiplier: 60 },
      "2026-07-10T01:00:00.000Z",
    );
    const realtimeReport = await simulator.reconcileSimulationClock({
      now: "2026-07-10T01:01:00.000Z",
    });
    expect(realtimeReport.simulationDeltaMs).toBe(60 * 60 * 1000);
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe(
      "2026-07-10T01:00:00.000Z",
    );

    await simulator.pauseClock("2026-07-10T01:01:00.000Z");
    const pausedReport = await simulator.reconcileSimulationClock({
      now: "2026-07-10T01:05:00.000Z",
    });
    expect(pausedReport.simulationDeltaMs).toBe(0);
    await simulator.resumeClock("2026-07-10T01:05:00.000Z");
    const resumedReport = await simulator.reconcileSimulationClock({
      now: "2026-07-10T01:06:00.000Z",
    });
    expect(resumedReport.simulationDeltaMs).toBe(60 * 60 * 1000);
    await simulator.close();

    const restarted = await SourceSimulator.create({
      storage: new SQLiteSimulatorStorage(databasePath),
      baseUrl: "http://sim.test",
    });
    expect((await restarted.clockStatus()).clock.lastReconciledSimulationTime).toBe(
      "2026-07-10T02:00:00.000Z",
    );
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
    const incremental = await app.request(
      `/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(initial.nextCursor)}`,
      {
        headers: connectionHeaders("secret-product-manager"),
      },
    );
    expect(incremental.status).toBe(200);
    const body = SourceFeedBatchV1Schema.parse(await incremental.json());
    expect(body.records.length).toBeGreaterThan(0);
    expect(body.records.some((record) => record.correlation.eventId !== "baseline")).toBe(true);
    expect((await simulator.clockStatus()).clock.reconciliationCount).toBeGreaterThan(0);
  });

  it("caps feed-triggered reconciliation so historical backlog is drained by later polls", async () => {
    const startedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const simulator = await SourceSimulator.create({
      seed: "feed-cap-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 30,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });
    const app = await createApp({
      simulator,
      runtimeEnv: "test",
      adminKey: "admin-test",
      connectionCredentials: { "secret-product-manager": "conn-product-manager" },
      feedReconciliationMaxCatchUpSeconds: 60,
    });

    const response = await app.request("/v1/connections/conn-product-manager/records?limit=10", {
      headers: connectionHeaders("secret-product-manager"),
    });

    expect(response.status).toBe(200);
    const status = await simulator.clockStatus();
    const report = status.clock.lastReconciliationReport;
    expect(status.clock.maxCatchUpSeconds).toBe(60 * 60 * 6);
    expect(report?.trigger).toBe("feed");
    expect(report?.wallTimeConsumedMs).toBe(60_000);
    expect(report?.simulationDeltaMs).toBe(30 * 60_000);
    expect(report?.wallTimeBacklogRemainingMs).toBeGreaterThan(0);
    expect(status.clock.lastReconciledSimulationTime).toBe(addMinutesIso(startedAt, 30));
  });

  it("preserves manual-event semantics during realtime reconciliation", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const simulator = await SourceSimulator.create({
      seed: "manual-realtime-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 60,
      continuousActivity: true,
      maxCatchUpSeconds: 60 * 60 * 48,
      maxSuccessorInstancesPerReconciliation: 20,
      minSuccessorIntervalHours: 0,
      baseUrl: "http://sim.test",
    });

    const afterScheduledManual = await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 37),
      trigger: "cron",
    });
    expect(afterScheduledManual.simulationDeltaMs).toBe(37 * 60 * 60 * 1000);
    const product = (await simulator.scenarioInstance("product-launch-readiness-default")).state;
    expect(product.currentTime).toBe(addHoursIso(product.startedAt, 37));
    expect(product.triggeredEventIds).not.toContain("exec-pressure");
    expect(product.eventOccurrenceTimes["exec-pressure"]).toBeUndefined();
    expect(product.eventLog.some((entry) => entry.eventId === "exec-pressure")).toBe(false);

    await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 50),
      trigger: "feed",
    });
    const beforeManualTrigger = (
      await simulator.scenarioInstance("product-launch-readiness-default")
    ).state;
    const manualOccurrenceTime = beforeManualTrigger.currentTime;
    await simulator.triggerScenarioInstanceEvent(
      "product-launch-readiness-default",
      "exec-pressure",
    );
    const afterManualTrigger = (
      await simulator.scenarioInstance("product-launch-readiness-default")
    ).state;
    expect(afterManualTrigger.eventOccurrenceTimes["exec-pressure"]).toBe(manualOccurrenceTime);
    expect(
      afterManualTrigger.eventLog.find((entry) => entry.eventId === "exec-pressure")?.occurredAt,
    ).toBe(manualOccurrenceTime);
    expect(
      (await simulator.sourceChanges()).some(
        (change) =>
          change.scenarioInstanceId === "product-launch-readiness-default" &&
          change.businessEventId === "exec-pressure",
      ),
    ).toBe(true);

    const changeCount = (await simulator.sourceChanges()).length;
    await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 55),
      trigger: "cron",
    });
    const afterRepeat = (await simulator.scenarioInstance("product-launch-readiness-default"))
      .state;
    expect(afterRepeat.eventOccurrenceTimes["exec-pressure"]).toBe(manualOccurrenceTime);
    expect(afterRepeat.eventLog.filter((entry) => entry.eventId === "exec-pressure")).toHaveLength(
      1,
    );
    expect((await simulator.sourceChanges()).length).toBeGreaterThanOrEqual(changeCount);

    await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 130),
      trigger: "cron",
    });
    const states = await simulator.states();
    expect(states.some((state) => state.scenarioInstanceId.includes("-continuous-"))).toBe(true);
    expect(
      (await simulator.scenarioInstance("product-launch-readiness-default")).state
        .eventOccurrenceTimes["exec-pressure"],
    ).toBe(manualOccurrenceTime);
  });

  it("drains bounded realtime catch-up backlog without skipped or duplicated intervals", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const outageEnd = addHoursIso(startedAt, 24);
    const simulator = await SourceSimulator.create({
      seed: "backlog-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });

    const reports = [
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "cron" }),
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "cron" }),
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "cron" }),
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "cron" }),
    ];
    expect(reports.map((report) => report.wallTimeConsumedMs)).toEqual(
      [6, 6, 6, 6].map((hours) => hours * 60 * 60 * 1000),
    );
    expect(reports.map((report) => report.wallTimeBacklogRemainingMs)).toEqual(
      [18, 12, 6, 0].map((hours) => hours * 60 * 60 * 1000),
    );
    expect(reports.map((report) => report.catchUpLimited)).toEqual([true, true, true, false]);
    expect((await simulator.clockStatus()).clock.lastReconciledWallTime).toBe(outageEnd);
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe(outageEnd);
    const changeIds = (await simulator.sourceChanges()).map((change) => change.changeId);
    expect(new Set(changeIds).size).toBe(changeIds.length);

    const concurrent = await SourceSimulator.create({
      seed: "backlog-concurrent-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });
    const concurrentReports = await Promise.all(
      Array.from({ length: 4 }, () =>
        concurrent.reconcileSimulationClock({ now: outageEnd, trigger: "cron" }),
      ),
    );
    expect(concurrentReports.reduce((sum, report) => sum + report.wallTimeConsumedMs, 0)).toBe(
      24 * 60 * 60 * 1000,
    );
    expect((await concurrent.clockStatus()).clock.lastReconciledSimulationTime).toBe(outageEnd);
    const concurrentChangeIds = (await concurrent.sourceChanges()).map((change) => change.changeId);
    expect(new Set(concurrentChangeIds).size).toBe(concurrentChangeIds.length);
  });

  it("rejects time-affecting clock configuration changes while catch-up backlog remains", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const outageEnd = addHoursIso(startedAt, 24);
    const simulator = await SourceSimulator.create({
      seed: "backlog-transition-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });
    const before = await clockWorldSnapshot(simulator);

    await expect(simulator.updateClock({ speedMultiplier: 2 }, outageEnd)).rejects.toMatchObject({
      status: 409,
      classification: "clock_backlog_conflict",
      details: { wallTimeBacklogRemainingMs: 18 * 60 * 60 * 1000 },
    });
    expect(await clockWorldSnapshot(simulator)).toEqual(before);
    await expect(simulator.updateClock({ speedMultiplier: 2 }, outageEnd)).rejects.toMatchObject({
      status: 409,
      classification: "clock_backlog_conflict",
    });
    expect(await clockWorldSnapshot(simulator)).toEqual(before);

    const firstDrain = await simulator.reconcileSimulationClock({
      now: outageEnd,
      trigger: "admin",
    });
    expect(firstDrain.simulationDeltaMs).toBe(6 * 60 * 60 * 1000);
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe(
      addHoursIso(startedAt, 6),
    );
    expect((await simulator.clockStatus()).clock.speedMultiplier).toBe(1);

    const remainingReports = [
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "admin" }),
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "admin" }),
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "admin" }),
    ];
    expect(remainingReports.map((report) => report.wallTimeBacklogRemainingMs)).toEqual(
      [12, 6, 0].map((hours) => hours * 60 * 60 * 1000),
    );
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe(outageEnd);

    await simulator.updateClock({ speedMultiplier: 2 }, outageEnd);
    expect((await simulator.clockStatus()).clock.speedMultiplier).toBe(2);
    await simulator.reconcileSimulationClock({ now: addHoursIso(outageEnd, 1), trigger: "admin" });
    expect((await simulator.clockStatus()).clock.lastReconciledSimulationTime).toBe(
      addHoursIso(startedAt, 26),
    );
    const changeIds = (await simulator.sourceChanges()).map((change) => change.changeId);
    expect(new Set(changeIds).size).toBe(changeIds.length);
  });

  it("allows true no-op clock updates while backlog remains", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const outageEnd = addHoursIso(startedAt, 24);
    const simulator = await SourceSimulator.create({
      seed: "backlog-noop-transition-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });

    const beforeLedger = await simulator.sourceChanges();
    await simulator.updateClock({ speedMultiplier: 1 }, outageEnd);
    const status = await simulator.clockStatus();
    expect(status.clock.speedMultiplier).toBe(1);
    expect(status.clock.mode).toBe("realtime");
    expect(status.clock.lastReconciledSimulationTime).toBe(addHoursIso(startedAt, 6));
    expect(status.clock.lastReconciliationReport?.wallTimeBacklogRemainingMs).toBe(
      18 * 60 * 60 * 1000,
    );
    expect((await simulator.sourceChanges()).length).toBeGreaterThanOrEqual(beforeLedger.length);
  });

  it("requires backlog drain before realtime-to-manual and pause transitions", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const outageEnd = addHoursIso(startedAt, 24);
    const makeSimulator = (seed: string) =>
      SourceSimulator.create({
        seed,
        now: startedAt,
        clockMode: "realtime",
        clockSpeedMultiplier: 1,
        maxCatchUpSeconds: 60 * 60 * 6,
        baseUrl: "http://sim.test",
      });

    const manual = await makeSimulator("backlog-manual-transition-seed");
    const manualBefore = await clockWorldSnapshot(manual);
    await expect(manual.updateClock({ mode: "manual" }, outageEnd)).rejects.toMatchObject({
      classification: "clock_backlog_conflict",
    });
    expect(await clockWorldSnapshot(manual)).toEqual(manualBefore);
    for (let index = 0; index < 4; index += 1)
      await manual.reconcileSimulationClock({ now: outageEnd, trigger: "admin" });
    await manual.updateClock({ mode: "manual" }, outageEnd);
    expect((await manual.clockStatus()).clock.mode).toBe("manual");
    const beforeManualNoop = await manual.clockStatus();
    await manual.updateClock({ mode: "manual" }, outageEnd);
    const afterManualNoop = await manual.clockStatus();
    expect(afterManualNoop.clock.mode).toBe(beforeManualNoop.clock.mode);
    expect(afterManualNoop.clock.speedMultiplier).toBe(beforeManualNoop.clock.speedMultiplier);
    expect(afterManualNoop.clock.lastReconciledSimulationTime).toBe(
      beforeManualNoop.clock.lastReconciledSimulationTime,
    );

    const pause = await makeSimulator("backlog-pause-transition-seed");
    const pauseBefore = await clockWorldSnapshot(pause);
    await expect(pause.updateClock({ paused: true }, outageEnd)).rejects.toMatchObject({
      classification: "clock_backlog_conflict",
    });
    expect(await clockWorldSnapshot(pause)).toEqual(pauseBefore);
    for (let index = 0; index < 4; index += 1)
      await pause.reconcileSimulationClock({ now: outageEnd, trigger: "admin" });
    await pause.updateClock({ paused: true }, outageEnd);
    expect((await pause.clockStatus()).clock.paused).toBe(true);
  });

  it("requires backlog drain before continuous activity and successor cadence changes", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const outageEnd = addHoursIso(startedAt, 24);
    const simulator = await SourceSimulator.create({
      seed: "backlog-orchestration-transition-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      continuousActivity: false,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });
    const before = await clockWorldSnapshot(simulator);
    for (const input of [
      { continuousActivity: true },
      { activityProfile: "intense" as const },
      { maxSuccessorInstancesPerReconciliation: 8 },
      { minSuccessorIntervalHours: 1 },
    ]) {
      await expect(simulator.updateClock(input, outageEnd)).rejects.toMatchObject({
        classification: "clock_backlog_conflict",
      });
      expect(await clockWorldSnapshot(simulator)).toEqual(before);
    }

    for (let index = 0; index < 4; index += 1)
      await simulator.reconcileSimulationClock({ now: outageEnd, trigger: "admin" });
    await simulator.updateClock(
      {
        continuousActivity: true,
        activityProfile: "intense",
        maxSuccessorInstancesPerReconciliation: 8,
        minSuccessorIntervalHours: 1,
      },
      outageEnd,
    );
    const status = await simulator.clockStatus();
    expect(status.clock.continuousActivity).toBe(true);
    expect(status.orchestration).toMatchObject({
      enabled: true,
      activityProfile: "intense",
      maxSuccessorInstancesPerReconciliation: 8,
      minSuccessorIntervalHours: 1,
    });
  });

  it("returns a structured 409 clock backlog conflict over HTTP", async () => {
    const startedAt = addHoursIso(new Date().toISOString(), -24);
    const simulator = await SourceSimulator.create({
      seed: "http-backlog-conflict-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 1,
      maxCatchUpSeconds: 60 * 60 * 6,
      baseUrl: "http://sim.test",
    });
    const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
    const before = await clockWorldSnapshot(simulator);
    const response = await app.request("/v1/admin/clock", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ speedMultiplier: 2 }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "Clock backlog must be reconciled before changing clock configuration",
      classification: "clock_backlog_conflict",
      correlationId: expect.any(String),
      wallTimeBacklogRemainingMs: expect.any(Number),
    });
    expect(body.wallTimeBacklogRemainingMs).toBeGreaterThan(0);
    expect(await clockWorldSnapshot(simulator)).toEqual(before);
  });

  it("applies lossless clock configuration transitions atomically", async () => {
    const startedAt = "2026-07-10T00:00:00.000Z";
    const simulator = await SourceSimulator.create({
      seed: "clock-transition-seed",
      now: startedAt,
      clockMode: "realtime",
      clockSpeedMultiplier: 60,
      maxCatchUpSeconds: 60 * 60,
      baseUrl: "http://sim.test",
    });
    const observedSimulationTimes: string[] = [];
    const remember = async () =>
      observedSimulationTimes.push(
        (await simulator.clockStatus()).clock.lastReconciledSimulationTime,
      );

    await simulator.updateClock({ paused: true }, addMinutesIso(startedAt, 5));
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 5));

    await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 10),
      trigger: "cron",
    });
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 5));

    await simulator.updateClock({ paused: false }, addMinutesIso(startedAt, 10));
    await simulator.updateClock({ speedMultiplier: 120 }, addMinutesIso(startedAt, 12));
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 7));

    await simulator.updateClock({ mode: "manual" }, addMinutesIso(startedAt, 14));
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 11));

    await simulator.reconcileSimulationClock({
      now: addMinutesIso(startedAt, 20),
      trigger: "admin",
    });
    await simulator.updateClock({ mode: "realtime" }, addMinutesIso(startedAt, 20));
    await simulator.updateClock(
      { continuousActivity: true, activityProfile: "quiet" },
      addMinutesIso(startedAt, 21),
    );
    const quiet = await simulator.clockStatus();
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 13));
    expect(quiet.orchestration).toMatchObject({
      enabled: true,
      activityProfile: "quiet",
      maxSuccessorInstancesPerReconciliation: 2,
      minSuccessorIntervalHours: 24,
    });

    await simulator.updateClock(
      {
        maxCatchUpSeconds: 60,
        maxSuccessorInstancesPerReconciliation: 5,
        minSuccessorIntervalHours: 3,
      },
      addMinutesIso(startedAt, 22),
    );
    const finalStatus = await simulator.clockStatus();
    await remember();
    expect(observedSimulationTimes.at(-1)).toBe(addHoursIso(startedAt, 15));
    expect(finalStatus.clock.maxCatchUpSeconds).toBe(60);
    expect(finalStatus.orchestration.maxSuccessorInstancesPerReconciliation).toBe(5);
    expect(finalStatus.orchestration.minSuccessorIntervalHours).toBe(3);
    for (let index = 1; index < observedSimulationTimes.length; index += 1) {
      expect(Date.parse(observedSimulationTimes[index]!)).toBeGreaterThanOrEqual(
        Date.parse(observedSimulationTimes[index - 1]!),
      );
    }
  });

  it("creates deterministic continuous successors idempotently in one shared company world", async () => {
    const simulator = await SourceSimulator.create({
      seed: "continuous-seed",
      now: "2026-07-10T00:00:00.000Z",
      clockMode: "realtime",
      clockSpeedMultiplier: 1440,
      continuousActivity: false,
      maxSuccessorInstancesPerReconciliation: 20,
      baseUrl: "http://sim.test",
    });
    await simulator.generateDataset({
      seed: "continuous-seed",
      datasetSize: "small",
      startTime: "2026-07-01T00:00:00.000Z",
    });
    await simulator.updateClock(
      { mode: "realtime", continuousActivity: true, speedMultiplier: 1440 },
      "2026-07-10T00:00:00.000Z",
    );
    const first = await simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" });
    expect(first.instancesCreated).toBe(10);
    const statesAfterFirst = await simulator.states();
    expect(new Set(statesAfterFirst.map((state) => state.scenarioInstanceId)).size).toBe(
      statesAfterFirst.length,
    );
    expect(
      statesAfterFirst.some((state) =>
        state.scenarioInstanceId.startsWith("major-cross-functional-product-release-continuous-"),
      ),
    ).toBe(true);

    const repeated = await simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" });
    expect(repeated.instancesCreated).toBe(0);
    expect(await simulator.states()).toHaveLength(statesAfterFirst.length);

    await simulator.reconcileSimulationClock({ now: "2026-07-10T00:06:00.000Z" });
    const majorSuccessor = (await simulator.states()).find((state) =>
      state.scenarioInstanceId.startsWith("major-cross-functional-product-release-continuous-"),
    )!;
    const majorSources = new Set(
      (await simulator.sourceChanges())
        .filter((change) => change.scenarioInstanceId === majorSuccessor.scenarioInstanceId)
        .map((change) => change.sourceSystem),
    );
    expect(majorSources.size).toBeGreaterThan(0);
    expect(majorSuccessor.triggeredEventIds).not.toContain("leadership-readout");
    expect(new Set((await simulator.sourceChanges()).map((change) => change.changeId)).size).toBe(
      (await simulator.sourceChanges()).length,
    );
  });

  it("enforces deterministic successor due times and bounded overdue creation", async () => {
    const startedAt = "2026-07-01T00:00:00.000Z";
    const simulator = await SourceSimulator.create({
      seed: "successor-due-seed",
      now: startedAt,
      clockMode: "manual",
      continuousActivity: false,
      baseUrl: "http://sim.test",
    });
    await simulator.generateDataset({
      seed: "successor-due-seed",
      datasetSize: "small",
      startTime: startedAt,
    });
    await simulator.updateClock(
      {
        mode: "realtime",
        continuousActivity: true,
        speedMultiplier: 1,
        maxCatchUpSeconds: 60 * 60 * 24,
        maxSuccessorInstancesPerReconciliation: 3,
        minSuccessorIntervalHours: 12,
      },
      "2026-07-08T00:00:00.000Z",
    );

    const notDue = await simulator.reconcileSimulationClock({
      now: "2026-07-08T11:59:00.000Z",
      trigger: "cron",
    });
    expect(notDue.instancesCreated).toBe(0);
    expect(
      (await simulator.states()).filter((state) =>
        state.scenarioInstanceId.includes("-continuous-"),
      ),
    ).toHaveLength(0);
    expect((await simulator.clockStatus()).orchestration.nextScheduledInstanceTime).toBe(
      "2026-07-08T12:00:00.000Z",
    );

    const exactlyDue = await simulator.reconcileSimulationClock({
      now: "2026-07-08T12:00:00.000Z",
      trigger: "cron",
    });
    expect(exactlyDue.instancesCreated).toBe(3);
    const firstCreated = (await simulator.states()).filter((state) =>
      state.scenarioInstanceId.includes("-continuous-"),
    );
    expect(firstCreated).toHaveLength(3);
    expect(firstCreated.every((state) => state.startedAt === "2026-07-08T12:00:00.000Z")).toBe(
      true,
    );
    expect(
      (await simulator.sourceChanges())
        .filter((change) =>
          firstCreated.some((state) => state.scenarioInstanceId === change.scenarioInstanceId),
        )
        .every(
          (change) => Date.parse(change.changeOccurredAt) <= Date.parse("2026-07-08T12:00:00.000Z"),
        ),
    ).toBe(true);

    const overdue = await simulator.reconcileSimulationClock({
      now: "2026-07-08T13:00:00.000Z",
      trigger: "cron",
    });
    expect(overdue.instancesCreated).toBe(3);
    const afterOverdue = (await simulator.states()).filter((state) =>
      state.scenarioInstanceId.includes("-continuous-"),
    );
    expect(afterOverdue).toHaveLength(6);
    const repeated = await simulator.reconcileSimulationClock({
      now: "2026-07-08T13:00:00.000Z",
      trigger: "cron",
    });
    expect(repeated.instancesCreated).toBe(3);
    expect(
      (await simulator.states()).filter((state) =>
        state.scenarioInstanceId.includes("-continuous-"),
      ),
    ).toHaveLength(9);
    const finalBounded = await simulator.reconcileSimulationClock({
      now: "2026-07-08T13:00:00.000Z",
      trigger: "cron",
    });
    expect(finalBounded.instancesCreated).toBe(1);
    expect(
      (await simulator.states()).filter((state) =>
        state.scenarioInstanceId.includes("-continuous-"),
      ),
    ).toHaveLength(10);
    expect(new Set((await simulator.states()).map((state) => state.scenarioInstanceId)).size).toBe(
      (await simulator.states()).length,
    );
  });

  it("reports source-object create, update, and delete counts from projection changes", async () => {
    const simulator = await SourceSimulator.create({
      seed: "object-metrics-seed",
      now: "2026-07-10T00:00:00.000Z",
      clockMode: "realtime",
      clockSpeedMultiplier: 60,
      maxCatchUpSeconds: 60 * 60 * 2,
      baseUrl: "http://sim.test",
    });
    const created = await simulator.reconcileSimulationClock({
      now: "2026-07-10T00:24:00.000Z",
      trigger: "cron",
    });
    expect(created.objectsCreated).toBeGreaterThan(0);
    expect(created.objectsChanged).toBe(
      created.objectsCreated + created.objectsUpdated + created.objectsDeleted,
    );
    const updated = await simulator.reconcileSimulationClock({
      now: "2026-07-10T00:30:00.000Z",
      trigger: "cron",
    });
    expect(updated.objectsUpdated).toBeGreaterThan(0);
    expect(updated.objectsChanged).toBe(
      updated.objectsCreated + updated.objectsUpdated + updated.objectsDeleted,
    );

    await simulator.triggerScenarioEvent("technical-debt-staffing-risk", "vp-investment");
    const beforeDeleteCount = (await simulator.sourceObjects()).filter(
      (object) => object.currentChangeType === "deleted",
    ).length;
    const deleted = await simulator.reconcileSimulationClock({
      now: "2026-07-10T01:06:00.000Z",
      trigger: "cron",
    });
    expect(deleted.objectsDeleted).toBeGreaterThan(0);
    expect(deleted.objectsChanged).toBe(
      deleted.objectsCreated + deleted.objectsUpdated + deleted.objectsDeleted,
    );
    const afterDeleteCount = (await simulator.sourceObjects()).filter(
      (object) => object.currentChangeType === "deleted",
    ).length;
    expect(afterDeleteCount).toBeGreaterThan(beforeDeleteCount);
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
    await expect(
      simulator.reconcileSimulationClock({ now: "2026-07-10T00:01:00.000Z" }),
    ).rejects.toThrow("Injected world replacement failure");
    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    expect((await simulator.clockStatus()).clock).toEqual(clockBefore);
    await simulator.close();
  });

  it("authorizes cron-compatible ticks and rejects missing or incorrect cron secrets", async () => {
    const simulator = await SourceSimulator.create({ seed: "cron-seed" });
    await withEnv({ CRON_SECRET: "cron-secret" }, async () => {
      const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
      expect((await app.request("/api/cron/tick")).status).toBe(401);
      expect(
        (await app.request("/api/cron/tick", { headers: { Authorization: "Bearer wrong" } }))
          .status,
      ).toBe(401);
      const ok = await app.request("/api/cron/tick", {
        headers: { Authorization: "Bearer cron-secret" },
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()).schemaVersion).toBe("simulation-cron-tick.v1");
    });
    await withEnv({ CRON_SECRET: undefined }, async () => {
      const app = await createApp({ simulator, runtimeEnv: "test", adminKey: "admin-test" });
      const missing = await app.request("/api/cron/tick", {
        headers: { Authorization: "Bearer cron-secret" },
      });
      expect(missing.status).toBe(503);
      expect((await missing.json()).classification).toBe("configuration_error");
    });
  });

  it("refreshes stale warm-process organization state before connection authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-sim-refresh-"));
    const databasePath = join(directory, "refresh.sqlite");
    const simulatorA = await SourceSimulator.create({
      storage: new SQLiteSimulatorStorage(databasePath),
      seed: "warm-a",
      baseUrl: "http://sim.test",
    });
    const simulatorB = await SourceSimulator.create({
      storage: new SQLiteSimulatorStorage(databasePath),
      seed: "warm-b",
      baseUrl: "http://sim.test",
    });
    const appA = await createApp({
      simulator: simulatorA,
      runtimeEnv: "test",
      adminKey: "admin-test",
    });
    const appB = await createApp({
      simulator: simulatorB,
      runtimeEnv: "test",
      adminKey: "admin-test",
    });
    const oldProductIcs = simulatorB
      .people()
      .filter((person) => person.roleTemplateId === "role-product-ic");
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
    const config = JSON.parse(
      await readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
    );
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const vercelEntrypoint = await readFile(new URL("../app.ts", import.meta.url), "utf8");
    expect(config.installCommand).toBe("pnpm install --frozen-lockfile");
    expect(config.buildCommand).toBeUndefined();
    expect(config.outputDirectory).toBeUndefined();
    expect(config.framework).toBeUndefined();
    expect(Object.keys(config.functions)).toEqual(["src/app.ts"]);
    expect(config.functions["src/app.ts"]).toEqual({
      maxDuration: 30,
      includeFiles: "migrations/*.sql",
    });
    expect(config.functions["src/app.ts"].runtime).toBeUndefined();
    expect(config.crons).toBeUndefined();
    expect(config.rewrites).toBeUndefined();
    expect(existsSync(new URL("../../api/index.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../server.ts", import.meta.url))).toBe(false);
    expect(vercelEntrypoint.trim()).toBe(
      'import type { Hono } from "hono";\nimport { createApp } from "./simulator-app.js";\n\nconst app: Hono = await createApp();\n\nexport default app;',
    );
    expect(packageJson.engines.node).toBe("22.x");
    expect(packageJson.packageManager).toBe("pnpm@9.15.9");

    const { app } = await credentialedApp();
    expect((await app.request("/")).status).toBe(302);
    expect((await app.request("/console")).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/v1/catalog")).status).toBe(200);
  });

  it("serializes concurrent source-world mutations without skipping or duplicating ledger entries", async () => {
    const simulator = await SourceSimulator.create({
      seed: "concurrency-seed",
      baseUrl: "http://sim.test",
    });
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
    const simulator = await SourceSimulator.create({
      seed: "http-connector-kit-seed",
      baseUrl: "http://sim.test",
    });
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
        await app.request(
          `/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(savedCursor)}`,
          {
            headers: connectionHeaders("secret-product-manager"),
          },
        )
      ).json(),
    );
    expect(
      incremental.records.some(
        (record) => record.correlation.scenarioId === "product-launch-readiness",
      ),
    ).toBe(true);

    await app.request("/v1/admin/scenario-instances/http-kit-instance/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ hours: 48 }),
    });
    const updates = SourceFeedBatchV1Schema.parse(
      await (
        await app.request(
          `/v1/connections/conn-product-manager/records?limit=100&cursor=${encodeURIComponent(incremental.nextCursor)}`,
          {
            headers: connectionHeaders("secret-product-manager"),
          },
        )
      ).json(),
    );
    expect(
      updates.records.some(
        (record) => record.changeType === "updated" || record.changeType === "deleted",
      ),
    ).toBe(true);

    const staleCursor = updates.nextCursor;
    await app.request("/v1/admin/scenario-instances/http-kit-instance/reset", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    const stale = await app.request(
      `/v1/connections/conn-product-manager/records?cursor=${encodeURIComponent(staleCursor)}`,
      {
        headers: connectionHeaders("secret-product-manager"),
      },
    );
    expect(stale.status).toBe(400);
    expect((await stale.json()).classification).toBe("stale_cursor");

    expect(
      (
        await app.request("/v1/connections/conn-product-manager/records", {
          headers: connectionHeaders("not-known"),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/connections/conn-product-manager/records", {
          headers: connectionHeaders("revoked-connection"),
        })
      ).status,
    ).toBe(401);
    const icPage = SourceFeedBatchV1Schema.parse(
      await (
        await app.request("/v1/connections/conn-product-ic/records?limit=100", {
          headers: connectionHeaders("secret-product-ic"),
        })
      ).json(),
    );
    expect(icPage.records.length).not.toBe(initial.records.length);

    await app.request("/v1/admin/failure-modes", {
      method: "PUT",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "failure-modes.v1",
        rules: [
          {
            id: "sim-429",
            enabled: true,
            mode: "rate_limit",
            operation: "feed",
            connectionId: "conn-product-manager",
          },
        ],
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
        rules: [
          {
            id: "sim-503",
            enabled: true,
            mode: "service_unavailable",
            operation: "manifest",
            connectionId: "conn-product-manager",
          },
        ],
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
          {
            id: "partial",
            enabled: true,
            mode: "partial_page",
            operation: "feed",
            connectionId: "conn-product-manager",
            pageSize: 1,
          },
          {
            id: "duplicate",
            enabled: true,
            mode: "duplicate_objects",
            operation: "feed",
            connectionId: "conn-product-manager",
          },
          {
            id: "edited",
            enabled: true,
            mode: "edited_objects",
            operation: "feed",
            connectionId: "conn-product-manager",
          },
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
        rules: [
          {
            id: "auth",
            enabled: true,
            mode: "auth_failure",
            operation: "manifest",
            connectionId: "conn-product-manager",
          },
        ],
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
        rules: [
          {
            id: "cursor",
            enabled: true,
            mode: "cursor_corruption",
            operation: "feed",
            connectionId: "conn-product-manager",
          },
        ],
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

    const instances = await app.request("/v1/catalog/scenario-instances", {
      headers: adminHeaders(),
    });
    const instanceBody = await instances.json();
    expect(instanceBody.scenarioInstances).toHaveLength(80);

    const dataset = await app.request("/v1/admin/datasets/current", { headers: adminHeaders() });
    expect((await dataset.json()).totalSourceChanges).toBeGreaterThanOrEqual(1_000);

    const sourceObjects = await app.request("/v1/admin/source-objects", {
      headers: adminHeaders(),
    });
    const object = (await sourceObjects.json()).sourceObjects[0];
    const history = await app.request(
      `/v1/admin/source-objects/${object.sourceSystem}/${object.sourceId}/history`,
      { headers: adminHeaders() },
    );
    expect((await history.json()).history[0].sourceId).toBe(object.sourceId);
  });

  it("creates real independent scenario instances through POST and validates duplicate and unknown packs", async () => {
    const { app, simulator } = await credentialedApp(
      await SourceSimulator.create({ seed: "api-create-seed", baseUrl: "http://sim.test" }),
    );
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
    expect((await simulator.scenarioInstance("api-created-instance")).state.seed).toBe(
      "api-created-seed",
    );

    const duplicate = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        scenarioPackId: "product-launch-readiness",
        scenarioInstanceId: "api-created-instance",
      }),
    });
    expect(duplicate.status).toBe(400);

    const unknown = await app.request("/v1/admin/scenario-instances", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        scenarioPackId: "not-a-pack",
        scenarioInstanceId: "missing-pack-instance",
      }),
    });
    expect(unknown.status).toBe(400);
  });

  it("persists POST-created scenario instances across SQLite restart", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-instance-api-")),
      "simulator.sqlite",
    );
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const firstSimulator = await SourceSimulator.create({
      seed: "sqlite-instance-create",
      storage: firstStorage,
      baseUrl: "http://sim.test",
    });
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
    const secondSimulator = await SourceSimulator.create({
      seed: "ignored-seed",
      storage: secondStorage,
      baseUrl: "http://sim.test",
    });
    expect((await secondSimulator.scenarioInstance("sqlite-created-instance")).state).toMatchObject(
      {
        scenarioPackId: "reliability-incident",
        seed: "sqlite-created-seed",
        service: "connector-gateway",
      },
    );
    secondStorage.close();
  });

  it("does not expose future changes through the admin source-change route", async () => {
    const { app } = await credentialedApp(
      await SourceSimulator.create({ seed: "api-ledger-seed", baseUrl: "http://sim.test" }),
    );
    const initial = await app.request("/v1/admin/source-changes", { headers: adminHeaders() });
    expect(
      (await initial.json()).sourceChanges.some(
        (change: { record: { title: string } }) =>
          change.record.title === "Workflow export API dependency",
      ),
    ).toBe(false);

    await app.request("/v1/admin/scenarios/product-launch-readiness/advance", {
      method: "POST",
      headers: { ...adminHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ hours: 24 }),
    });
    const advanced = await app.request("/v1/admin/source-changes", { headers: adminHeaders() });
    expect(
      (await advanced.json()).sourceChanges.some(
        (change: { record: { title: string } }) =>
          change.record.title === "Workflow export API dependency",
      ),
    ).toBe(true);
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
    const migrationSql = await readFile(
      new URL("../../migrations/001_initial.sql", import.meta.url),
      "utf8",
    );
    const runtimeDatabasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-runtime-schema-")),
      "runtime.sqlite",
    );
    const runtimeStorage = new SQLiteSimulatorStorage(runtimeDatabasePath);
    runtimeStorage.close();

    const migrationDatabase = openTestSQLiteDatabase(":memory:");
    const runtimeDatabase = openTestSQLiteDatabase(runtimeDatabasePath);
    try {
      migrationDatabase.exec(migrationSql);
      const expectedSchema = {
        dataset_metadata:
          "CREATE TABLE dataset_metadata ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), metadata_json TEXT NOT NULL )",
        organization_config:
          "CREATE TABLE organization_config ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), config_json TEXT NOT NULL )",
        scenario_instance_states:
          "CREATE TABLE scenario_instance_states ( scenario_instance_id TEXT PRIMARY KEY, scenario_pack_id TEXT NOT NULL, state_json TEXT NOT NULL )",
        scenario_states:
          "CREATE TABLE scenario_states ( scenario_id TEXT PRIMARY KEY, state_json TEXT NOT NULL )",
        continuous_orchestration_state:
          "CREATE TABLE continuous_orchestration_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL )",
        simulation_clock_state:
          "CREATE TABLE simulation_clock_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), state_json TEXT NOT NULL )",
        source_change_ledger:
          "CREATE TABLE source_change_ledger ( ledger_sequence INTEGER PRIMARY KEY, world_revision TEXT NOT NULL, change_json TEXT NOT NULL )",
        source_objects:
          "CREATE TABLE source_objects ( source_key TEXT PRIMARY KEY, world_revision TEXT NOT NULL, object_json TEXT NOT NULL )",
        snapshots:
          "CREATE TABLE snapshots ( snapshot_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, snapshot_json TEXT NOT NULL )",
        world_state:
          "CREATE TABLE world_state ( id TEXT PRIMARY KEY CHECK (id = 'singleton'), world_revision TEXT NOT NULL )",
      };
      const normalizedExpectedSchema = Object.fromEntries(
        Object.entries(expectedSchema).map(([name, sql]) => [name, normalizeSql(sql)]),
      );
      expect(durableTableSql(migrationDatabase)).toEqual(normalizedExpectedSchema);
      expect(durableTableSql(runtimeDatabase)).toEqual(normalizedExpectedSchema);
    } finally {
      migrationDatabase.close();
      runtimeDatabase.close();
    }
  });

  it("rolls back failed world replacement during scenario instance creation", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-atomic-create-")),
      "simulator.sqlite",
    );
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({
      seed: "atomic-create-seed",
      storage,
      baseUrl: "http://sim.test",
    });
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
    await expect(simulator.scenarioInstance("should-roll-back")).rejects.toThrow(
      "Unknown scenario instance",
    );
    await storage.close();
  });

  it("rolls back failed world replacement during scenario instance reset", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-atomic-reset-")),
      "simulator.sqlite",
    );
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({
      seed: "atomic-reset-seed",
      storage,
      baseUrl: "http://sim.test",
    });
    await simulator.advanceScenario("product-launch-readiness", { hours: 24 });
    const before = await storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    await expect(
      simulator.resetScenarioInstance("product-launch-readiness-default", {
        seed: "failed-reset-seed",
      }),
    ).rejects.toThrow("Injected world replacement failure");

    expect(await storageWorldSnapshot(simulator)).toEqual(before);
    await storage.close();
  });

  it("rolls back failed world replacement during dataset generation", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-atomic-dataset-")),
      "simulator.sqlite",
    );
    const storage = new SQLiteSimulatorStorage(databasePath);
    const simulator = await SourceSimulator.create({
      seed: "atomic-dataset-seed",
      storage,
      baseUrl: "http://sim.test",
    });
    const before = await storageWorldSnapshot(simulator);

    storage.injectWorldReplacementFailureForTesting();
    await expect(
      simulator.generateDataset({ seed: "failed-dataset-seed", datasetSize: "medium" }),
    ).rejects.toThrow("Injected world replacement failure");

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
    expect((await second.state("product-launch-readiness")).currentTime).toBe(
      stateBefore.currentTime,
    );
    expect(second.organizationSummary().seed).toBe("sqlite-org-seed");
    expect((await second.listSnapshots()).map((candidate) => candidate.snapshotId)).toContain(
      snapshot.snapshotId,
    );
    expect(await second.datasetMetadata()).toEqual(metadataBefore);
    expect((await second.feed("conn-product-manager", firstCursor, 10)).worldRevision).toBe(
      metadataBefore.worldRevision,
    );
    expect((await second.sourceChanges()).length).toBe(metadataBefore.totalSourceChanges);
    await secondStorage.close();
  });

  it("persists manual trigger occurrence time across engine recreation", async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "source-sim-manual-trigger-")),
      "simulator.sqlite",
    );
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = await SourceSimulator.create({
      seed: "sqlite-manual-trigger-seed",
      storage: firstStorage,
      baseUrl: "http://sim.test",
    });
    const triggerTime = (await first.state("product-launch-readiness")).currentTime;
    await first.triggerScenarioEvent("product-launch-readiness", "exec-pressure");
    const beforeRestart = await first.state("product-launch-readiness");
    expect(beforeRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    await firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = await SourceSimulator.create({
      seed: "ignored-seed",
      storage: secondStorage,
      baseUrl: "http://sim.test",
    });
    const afterRestart = await second.state("product-launch-readiness");
    expect(afterRestart.eventOccurrenceTimes["exec-pressure"]).toBe(triggerTime);
    expect(
      afterRestart.eventLog.find((entry) => entry.eventId === "exec-pressure")?.occurredAt,
    ).toBe(triggerTime);
    expect(
      (await second.sourceChanges()).some(
        (change) =>
          change.record.title === "Launch date question for staff" &&
          change.changeOccurredAt === triggerTime,
      ),
    ).toBe(true);
    await secondStorage.close();
  });
});

describePostgres("Postgres storage", () => {
  it("matches SQLite source-ledger behavior and persists across engine recreation", async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), "source-sim-pg-parity-")), "sqlite.sqlite");
    const sqliteStorage = new SQLiteSimulatorStorage(sqlitePath);
    const schema = `sim_test_parity_${Date.now()}`;
    const postgresStorage = new PostgresSimulatorStorage({
      connectionString: postgresTestUrl!,
      schema,
    });
    let restartedStorage: PostgresSimulatorStorage | undefined;
    try {
      const sqlite = await SourceSimulator.create({
        seed: "postgres-parity",
        storage: sqliteStorage,
        baseUrl: "http://sim.test",
      });
      const postgres = await SourceSimulator.create({
        seed: "postgres-parity",
        storage: postgresStorage,
        baseUrl: "http://sim.test",
      });
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
      expect(
        (await postgres.feed("conn-product-manager", undefined, 20)).records.map(
          (record) => record.sourceId,
        ),
      ).toEqual(
        (await sqlite.feed("conn-product-manager", undefined, 20)).records.map(
          (record) => record.sourceId,
        ),
      );
      const metadataBeforeRestart = await postgres.datasetMetadata();
      await postgresStorage.close();

      restartedStorage = new PostgresSimulatorStorage({
        connectionString: postgresTestUrl!,
        schema,
      });
      try {
        const restarted = await SourceSimulator.create({
          seed: "ignored",
          storage: restartedStorage,
          baseUrl: "http://sim.test",
        });
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
    const storage = new PostgresSimulatorStorage({
      connectionString: postgresTestUrl!,
      schema: `sim_test_atomic_${Date.now()}`,
    });
    try {
      const simulator = await SourceSimulator.create({
        seed: "postgres-atomic",
        storage,
        baseUrl: "http://sim.test",
      });
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
      expect((await simulatorA.clockStatus()).clock.lastReconciledSimulationTime).toBe(
        "2026-07-10T01:00:00.000Z",
      );

      storageB = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
      const simulatorB = await SourceSimulator.create({
        seed: "ignored",
        storage: storageB,
        baseUrl: "http://sim.test",
      });
      expect((await simulatorB.clockStatus()).clock.lastReconciledSimulationTime).toBe(
        "2026-07-10T01:00:00.000Z",
      );

      const appA = await createApp({
        simulator: simulatorA,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson: JSON.stringify({
          enabled: true,
          windowMs: 60_000,
          adminLimit: 10,
          connectionLimit: 1,
          cronLimit: 10,
        }),
      });
      const appB = await createApp({
        simulator: simulatorB,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson: JSON.stringify({
          enabled: true,
          windowMs: 60_000,
          adminLimit: 10,
          connectionLimit: 1,
          cronLimit: 10,
        }),
      });
      expect(
        (
          await appA.request("/v1/connections/conn-product-manager/manifest", {
            headers: connectionHeaders("prod-product-manager"),
          })
        ).status,
      ).toBe(200);
      const limited = await appB.request("/v1/connections/conn-product-manager/manifest", {
        headers: connectionHeaders("prod-product-manager"),
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toEqual(expect.any(String));
    } finally {
      await storageB?.close();
      await storageA.dropOwnedSchemaForTesting();
      await storageA.close();
    }
  });

  it("atomically counts simultaneous first requests in the distributed Postgres rate limiter", async () => {
    const schema = `sim_test_rate_atomic_${Date.now()}`;
    const storageA = new PostgresSimulatorStorage({
      connectionString: postgresTestUrl!,
      schema,
      maxPoolSize: 10,
    });
    let storageB: PostgresSimulatorStorage | undefined;
    const pool = new Pool({ connectionString: postgresTestUrl! });
    try {
      const simulatorA = await SourceSimulator.create({
        seed: "postgres-rate-a",
        storage: storageA,
        baseUrl: "http://sim.test",
      });
      storageB = new PostgresSimulatorStorage({
        connectionString: postgresTestUrl!,
        schema,
        maxPoolSize: 10,
      });
      const simulatorB = await SourceSimulator.create({
        seed: "postgres-rate-b",
        storage: storageB,
        baseUrl: "http://sim.test",
      });
      const rateLimitConfigJson = JSON.stringify({
        enabled: true,
        windowMs: 60_000,
        adminLimit: 10,
        connectionLimit: 2,
        cronLimit: 10,
      });
      const appA = await createApp({
        simulator: simulatorA,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson,
      });
      const appB = await createApp({
        simulator: simulatorB,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "prod-product-manager": "conn-product-manager" },
        rateLimitConfigJson,
      });
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          (index % 2 === 0 ? appA : appB).request("/v1/connections/conn-product-manager/manifest", {
            headers: connectionHeaders("prod-product-manager"),
          }),
        ),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
      const limited = responses.filter((response) => response.status === 429);
      expect(limited).toHaveLength(3);
      for (const response of limited) {
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
        expect(Number(response.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
      }
      const rows = (
        await pool.query<{ identity_key: string; request_count: number }>(
          `SELECT identity_key, request_count FROM "${schema}".rate_limit_buckets WHERE scope = 'connection'`,
        )
      ).rows;
      expect(rows).toContainEqual({ identity_key: "conn-product-manager", request_count: 5 });
      expect(rows.map((row) => row.identity_key).join(" ")).not.toContain("prod-product-manager");
    } finally {
      await pool.end();
      await storageB?.close();
      await storageA.dropOwnedSchemaForTesting();
      await storageA.close();
    }
  });

  it("reconciles with the organization from the locked Postgres world snapshot across warm instances", async () => {
    const schema = `sim_test_org_snapshot_${Date.now()}`;
    const storageA = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
    let storageB: PostgresSimulatorStorage | undefined;
    try {
      const simulatorA = await SourceSimulator.create({
        seed: "postgres-org-a",
        storage: storageA,
        now: "2026-07-10T00:00:00.000Z",
        baseUrl: "http://sim.test",
      });
      storageB = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
      const simulatorB = await SourceSimulator.create({
        seed: "postgres-org-b",
        storage: storageB,
        now: "2026-07-10T00:00:00.000Z",
        clockMode: "realtime",
        clockSpeedMultiplier: 60,
        maxCatchUpSeconds: 60 * 60 * 2,
        baseUrl: "http://sim.test",
      });
      await simulatorB.updateClock(
        { mode: "realtime", speedMultiplier: 60 },
        "2026-07-10T00:00:00.000Z",
      );
      const oldProductIcs = simulatorB
        .people()
        .filter((person) => person.roleTemplateId === "role-product-ic");
      const removedPerson = oldProductIcs[oldProductIcs.length - 1]!;
      const removedConnectionId = personConnectionId(removedPerson);
      const appB = await withEnv({ CRON_SECRET: "postgres-cron-secret" }, () =>
        createApp({ simulator: simulatorB, runtimeEnv: "test", adminKey: "admin-test" }),
      );

      const nextConfig = cloneDefaultOrganizationConfig();
      nextConfig.seed = "postgres-org-new-seed";
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
      await simulatorA.regenerateOrganization({ config: nextConfig });

      await withEnv({ CRON_SECRET: "postgres-cron-secret" }, async () => {
        const tick = await appB.request("/api/cron/tick", {
          headers: { Authorization: "Bearer postgres-cron-secret" },
        });
        expect(tick.status).toBe(200);
      });
      const currentPeopleIds = new Set(simulatorB.people().map((person) => person.id));
      expect(currentPeopleIds.has(removedPerson.id)).toBe(false);
      const serializedChanges = JSON.stringify(await simulatorB.sourceChanges());
      expect(serializedChanges).not.toContain(removedPerson.id);
      for (const change of await simulatorB.sourceChanges()) {
        expect(currentPeopleIds.has(String(change.record.actorRef))).toBe(true);
        expect(assertNoSimulatorMetadata(change.record.rawPayload).ok).toBe(true);
      }

      const oldConnection = await appB.request(`/v1/connections/${removedConnectionId}/manifest`, {
        headers: developmentConnectionHeaders(removedConnectionId),
      });
      expect(oldConnection.status).toBe(401);
      const roleAlias = await appB.request("/v1/connections/conn-product-ic/manifest", {
        headers: developmentConnectionHeaders("conn-product-ic"),
      });
      expect(roleAlias.status).toBe(200);
    } finally {
      await storageB?.close();
      await storageA.dropOwnedSchemaForTesting();
      await storageA.close();
    }
  });

  it("rolls back rejected clock configuration transitions with backlog in Postgres", async () => {
    const schema = `sim_test_clock_backlog_${Date.now()}`;
    const storage = new PostgresSimulatorStorage({ connectionString: postgresTestUrl!, schema });
    try {
      const startedAt = "2026-07-10T00:00:00.000Z";
      const outageEnd = addHoursIso(startedAt, 24);
      const simulator = await SourceSimulator.create({
        seed: "postgres-backlog-transition-seed",
        storage,
        now: startedAt,
        clockMode: "realtime",
        clockSpeedMultiplier: 1,
        maxCatchUpSeconds: 60 * 60 * 6,
        baseUrl: "http://sim.test",
      });
      const before = await clockWorldSnapshot(simulator);
      await expect(simulator.updateClock({ speedMultiplier: 2 }, outageEnd)).rejects.toMatchObject({
        status: 409,
        classification: "clock_backlog_conflict",
        details: { wallTimeBacklogRemainingMs: 18 * 60 * 60 * 1000 },
      });
      expect(await clockWorldSnapshot(simulator)).toEqual(before);
    } finally {
      await storage.dropOwnedSchemaForTesting();
      await storage.close();
    }
  });
});

describe("contract artifacts", () => {
  it("keeps OpenAPI and JSON Schema examples aligned with the runtime contract", async () => {
    const example = JSON.parse(
      await readFile(
        new URL("../../examples/jira-engineering-feed.v1.json", import.meta.url),
        "utf8",
      ),
    );
    expect(SourceFeedBatchV1Schema.safeParse(example).success).toBe(true);

    const openApi = await readFile(
      new URL("../../openapi/source-simulator.v1.yaml", import.meta.url),
      "utf8",
    );
    const postgresMigration = await readFile(
      new URL("../../migrations/postgres_001_initial.sql", import.meta.url),
      "utf8",
    );
    const postgresClockMigration = await readFile(
      new URL("../../migrations/postgres_002_clock_runtime.sql", import.meta.url),
      "utf8",
    );
    const jsonSchema = JSON.parse(
      await readFile(new URL("../../schemas/source-feed-batch.v1.json", import.meta.url), "utf8"),
    );

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
    for (const table of [
      "simulation_clock_state",
      "continuous_orchestration_state",
      "rate_limit_buckets",
    ]) {
      expect(postgresClockMigration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(openApi).toContain("connectionBoundCredential");
    expect(openApi).toContain("cronBearer");
    expect(jsonSchema.$defs.sourceRecord.required).toContain("correlation");
  });
});
