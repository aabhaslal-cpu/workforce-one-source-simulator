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
import { MemorySimulatorStorage, SQLiteSimulatorStorage } from "../storage.js";
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
  simulator.advanceScenario("reliability-incident", { hours: 48 });
  simulator.advanceScenario("renewal-risk", { hours: 48 });
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
  const rows = database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?, ?, ?, ?) ORDER BY name").all(
    "scenario_states",
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
    const simulator = new SourceSimulator({ seed: "large-cursor-seed", datasetSize: "large" });
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
    const before = simulator.allRecords().map((record) => record.sourceId);
    const snapshot = simulator.createSnapshot();
    simulator.regenerateOrganization({ seed: "changed-org" });
    simulator.restoreSnapshot(snapshot.snapshotId);
    const after = simulator.allRecords().map((record) => record.sourceId);

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
    const simulator = new SourceSimulator({ seed: "history-seed" });
    const deletedChange = simulator.sourceChanges().find((change) => change.record.title === "Deferred retry remediation item" && change.changeType === "deleted");
    expect(deletedChange).toBeDefined();

    const history = simulator.sourceObjectHistory(deletedChange!.sourceSystem, deletedChange!.sourceId);
    expect(history.map((change) => change.sourceId)).toEqual(history.map(() => deletedChange!.sourceId));
    expect(history.map((change) => change.changeType)).toEqual(["created", "deleted"]);
  });
});

describe("Milestone 2 scenario packs and adapters", () => {
  it("registers all required source adapters and validates emitted provider payloads", () => {
    const simulator = new SourceSimulator({ seed: "adapter-seed" });
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
    const small = new SourceSimulator({ seed: "dataset-seed", datasetSize: "small" }).datasetMetadata();
    const medium = new SourceSimulator({ seed: "dataset-seed", datasetSize: "medium" }).datasetMetadata();
    const mediumReplay = new SourceSimulator({ seed: "dataset-seed", datasetSize: "medium" }).datasetMetadata();
    const large = new SourceSimulator({ seed: "dataset-seed", datasetSize: "large" }).datasetMetadata();

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

describe("Milestone 2 admin APIs", () => {
  it("exposes scenario packs, instances, dataset metadata, and source history through admin routes", async () => {
    const { app } = credentialedApp(new SourceSimulator({ seed: "api-m2-seed", datasetSize: "medium", baseUrl: "http://sim.test" }));

    const packs = await app.request("/v1/catalog/scenario-packs");
    expect(packs.status).toBe(200);
    expect((await packs.json()).scenarioPacks).toHaveLength(10);

    const instances = await app.request("/v1/catalog/scenario-instances");
    const instanceBody = await instances.json();
    expect(instanceBody.scenarioInstances).toHaveLength(80);

    const dataset = await app.request("/v1/admin/datasets/current", { headers: adminHeaders() });
    expect((await dataset.json()).totalSourceChanges).toBeGreaterThanOrEqual(1_000);

    const sourceObjects = await app.request("/v1/admin/source-objects", { headers: adminHeaders() });
    const object = (await sourceObjects.json()).sourceObjects[0];
    const history = await app.request(`/v1/admin/source-objects/${object.sourceSystem}/${object.sourceId}/history`, { headers: adminHeaders() });
    expect((await history.json()).history[0].sourceId).toBe(object.sourceId);
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
});

describe("contract artifacts", () => {
  it("keeps OpenAPI and JSON Schema examples aligned with the runtime contract", async () => {
    const example = JSON.parse(await readFile(new URL("../../examples/jira-engineering-feed.v1.json", import.meta.url), "utf8"));
    expect(SourceFeedBatchV1Schema.safeParse(example).success).toBe(true);

    const openApi = await readFile(new URL("../../openapi/source-simulator.v1.yaml", import.meta.url), "utf8");
    const jsonSchema = JSON.parse(await readFile(new URL("../../schemas/source-feed-batch.v1.json", import.meta.url), "utf8"));

    expect(openApi).toContain("/sim/{sourceSystem}/{sourceId}");
    expect(openApi).toContain("connectionBoundCredential");
    expect(jsonSchema.$defs.sourceRecord.required).toContain("correlation");
  });
});
