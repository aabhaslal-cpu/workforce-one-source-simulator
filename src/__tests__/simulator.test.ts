import { describe, expect, it } from "vitest";
import { SourceFeedBatchV1Schema } from "../contracts.js";
import { SourceSimulator } from "../engine.js";
import { createApp } from "../app.js";

function advancedSimulator(seed = "test-seed") {
  const simulator = new SourceSimulator({ seed, baseUrl: "http://sim.test" });
  simulator.advanceScenario("product-launch-readiness", { hours: 48 });
  simulator.advanceScenario("reliability-incident", { hours: 48 });
  simulator.advanceScenario("renewal-risk", { hours: 48 });
  return simulator;
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

  it("filters executive-only records away from IC connections", () => {
    const simulator = advancedSimulator();
    const productIc = simulator.feed("conn-product-ic", undefined, 250);
    const productVp = simulator.feed("conn-product-vp", undefined, 250);

    expect(productIc.records.some((record) => record.title === "Launch date question for staff")).toBe(false);
    expect(productVp.records.some((record) => record.title === "Launch date question for staff")).toBe(true);
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
});

describe("HTTP API", () => {
  it("enforces separate admin and connection credentials", async () => {
    const app = createApp({ adminKey: "admin-test", connectionSecret: "conn-test", simulator: advancedSimulator() });

    const noAdmin = await app.request("/v1/admin/records");
    expect(noAdmin.status).toBe(401);

    const admin = await app.request("/v1/admin/records", { headers: { "x-admin-api-key": "admin-test" } });
    expect(admin.status).toBe(200);

    const wrongConnection = await app.request("/v1/connections/conn-product-manager/records", { headers: { "x-connection-secret": "admin-test" } });
    expect(wrongConnection.status).toBe(401);

    const connection = await app.request("/v1/connections/conn-product-manager/records", { headers: { "x-connection-secret": "conn-test" } });
    expect(connection.status).toBe(200);
    expect(SourceFeedBatchV1Schema.parse(await connection.json()).schemaVersion).toBe("source-feed.v1");
  });

  it("exposes organization catalog and admin generation APIs", async () => {
    const app = createApp({ adminKey: "admin-test", connectionSecret: "conn-test", simulator: advancedSimulator() });
    const people = await app.request("/v1/catalog/people");
    expect(people.status).toBe(200);

    const generated = await app.request("/v1/admin/organization/generate", {
      method: "POST",
      headers: { "x-admin-api-key": "admin-test", "content-type": "application/json" },
      body: JSON.stringify({ seed: "new-org-seed" }),
    });
    expect(generated.status).toBe(200);
    const body = await generated.json();
    expect(body.organization.seed).toBe("new-org-seed");
    expect(body.organization.validation.ok).toBe(true);
  });
});
