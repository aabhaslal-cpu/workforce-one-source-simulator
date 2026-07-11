import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceFeedBatchV1Schema } from "../contracts.js";
import { SourceSimulator } from "../engine.js";
import { createApp } from "../app.js";
import { SQLiteSimulatorStorage } from "../storage.js";

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
    const second = simulator.feed("conn-product-manager", first.nextCursor ?? undefined, 2);
    const retry = simulator.feed("conn-product-manager", first.nextCursor ?? undefined, 2);

    expect(SourceFeedBatchV1Schema.parse(first)).toEqual(first);
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.records.map((record) => record.sourceId)).toEqual(retry.records.map((record) => record.sourceId));
    expect(new Set([...first.records, ...second.records].map((record) => record.sourceId)).size).toBe(4);
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
    const created = simulator.feed("conn-product-manager", undefined, 100).records.find((record) => record.title === "Workflow export API dependency");
    expect(created).toBeDefined();
    expect(created?.updatedAt).toBeUndefined();
    expect(created?.rawPayload.simulatorVersion).toBe("initial");

    simulator.advanceScenario("product-launch-readiness", { hours: 5 });
    const beforeUpdate = simulator.feed("conn-product-manager", undefined, 100).records.find((record) => record.sourceId === created?.sourceId);
    expect(beforeUpdate?.updatedAt).toBeUndefined();

    simulator.advanceScenario("product-launch-readiness", { hours: 1 });
    const updated = simulator.feed("conn-product-manager", undefined, 100).records.find((record) => record.sourceId === created?.sourceId);
    expect(updated?.sourceId).toBe(created?.sourceId);
    expect(updated?.updatedAt).toBe("2026-07-11T22:00:00.000Z");
    expect(updated?.rawPayload.simulatorVersion).toBe("updated");
  });

  it("exposes timeline mutations through incremental feeds with stable source identity", () => {
    const simulator = new SourceSimulator({ seed: "feed-update-seed", baseUrl: "http://sim.test" });
    simulator.advanceScenario("reliability-incident", { hours: 5 });
    const initial = simulator.feed("conn-engineering-manager", undefined, 100).records.find((record) => record.title === "Throttle connector retries under queue pressure");
    expect(initial?.updatedAt).toBeUndefined();

    simulator.advanceScenario("reliability-incident", { hours: 3 });
    const afterUpdate = simulator.feed("conn-engineering-manager", undefined, 100).records.find((record) => record.sourceId === initial?.sourceId);
    expect(afterUpdate?.sourceId).toBe(initial?.sourceId);
    expect(afterUpdate?.updatedAt).toBe("2026-07-11T00:00:00.000Z");
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

  it("rejects unsafe production credential configuration", () => {
    const simulator = advancedSimulator();
    expect(() => createApp({ simulator, runtimeEnv: "production", connectionCredentials: { prod: "conn-product-manager" } })).toThrow(
      /ADMIN_API_KEY/,
    );
    expect(() => createApp({ simulator, runtimeEnv: "production", adminKey: "prod-admin" })).toThrow(/Connection-bound credentials/);
    expect(() =>
      createApp({ simulator, runtimeEnv: "production", adminKey: DEV_ADMIN_FOR_TEST, connectionCredentials: { prod: "conn-product-manager" } }),
    ).toThrow(/development admin/);
    expect(() =>
      createApp({
        simulator,
        runtimeEnv: "production",
        adminKey: "prod-admin",
        connectionCredentials: { "dev-connection-secret:conn-product-manager": "conn-product-manager" },
      }),
    ).toThrow(/development connection/);
    expect(() =>
      createApp({ simulator, runtimeEnv: "production", adminKey: "same-secret", connectionCredentials: { "same-secret": "conn-product-manager" } }),
    ).toThrow(/must be different/);
  });
});

const DEV_ADMIN_FOR_TEST = "dev-admin-key";

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

describe("SQLite storage", () => {
  it("persists scenario states, organization config, and snapshots across engine recreation", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "source-sim-")), "simulator.sqlite");
    const firstStorage = new SQLiteSimulatorStorage(databasePath);
    const first = new SourceSimulator({ seed: "sqlite-seed", storage: firstStorage });
    first.advanceScenario("product-launch-readiness", { hours: 24 });
    first.regenerateOrganization({ seed: "sqlite-org-seed" });
    const snapshot = first.createSnapshot();
    const stateBefore = first.state("product-launch-readiness");
    firstStorage.close();

    const secondStorage = new SQLiteSimulatorStorage(databasePath);
    const second = new SourceSimulator({ seed: "other-seed", storage: secondStorage });
    expect(second.state("product-launch-readiness").currentTime).toBe(stateBefore.currentTime);
    expect(second.organizationSummary().seed).toBe("sqlite-org-seed");
    expect(second.listSnapshots().map((candidate) => candidate.snapshotId)).toContain(snapshot.snapshotId);
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
