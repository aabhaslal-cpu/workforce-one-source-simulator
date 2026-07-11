import { SourceFeedBatchV1Schema } from "./contracts.js";
import { scenarios } from "./data.js";
import { SourceSimulator } from "./engine.js";

export interface ConnectorKitStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConnectorKitReport {
  schemaVersion: "connector-test-kit.v1";
  generatedAt: string;
  connectionId: string;
  worldRevision: string;
  steps: ConnectorKitStep[];
}

export function runConnectorTestKit(): ConnectorKitReport {
  const simulator = new SourceSimulator({ seed: "connector-kit-seed", baseUrl: "http://sim.test" });
  const connectionId = "conn-product-vp";
  const steps: ConnectorKitStep[] = [];

  const initial = SourceFeedBatchV1Schema.parse(simulator.feed(connectionId, undefined, 25));
  steps.push({
    name: "initial_sync",
    ok: initial.records.length > 0 && initial.nextCursor.length > 0,
    detail: `${initial.records.length} records returned`,
  });

  const savedCursor = initial.nextCursor;
  const pack = scenarios.find((scenario) => scenario.id === "product-launch-readiness")!;
  const manualEvent = pack.events.find((event) => event.manual)!;
  const instanceId = "connector-kit-manual-instance";
  simulator.createScenarioInstance({
    scenarioPackId: pack.id,
    scenarioInstanceId: instanceId,
    seed: "connector-kit-manual-seed",
    product: "Connector Gateway",
    account: "Connector Kit Account",
  });
  simulator.triggerScenarioInstanceEvent(instanceId, manualEvent.id);
  const triggered = SourceFeedBatchV1Schema.parse(simulator.feed(connectionId, savedCursor, 25));
  steps.push({
    name: "manual_late_arrival_incremental_sync",
    ok: triggered.records.some((record) => record.correlation.eventId === manualEvent.id),
    detail: `${triggered.records.length} records returned after saved cursor`,
  });

  const retry = SourceFeedBatchV1Schema.parse(simulator.feed(connectionId, savedCursor, 25));
  steps.push({
    name: "retry_same_cursor",
    ok: JSON.stringify(retry) === JSON.stringify(triggered),
    detail: "same cursor returns the same page deterministically",
  });

  simulator.advanceScenarioInstance(instanceId, { hours: 48 });
  const afterUpdate = SourceFeedBatchV1Schema.parse(simulator.feed(connectionId, triggered.nextCursor, 25));
  steps.push({
    name: "updates_and_deletes_incremental_sync",
    ok: afterUpdate.records.some((record) => record.changeType === "updated" || record.changeType === "deleted"),
    detail: `${afterUpdate.records.length} changed records after trigger-time advancement`,
  });

  const beforeResetCursor = afterUpdate.nextCursor;
  simulator.resetScenarioInstance(instanceId);
  let staleCursorRejected = false;
  try {
    simulator.feed(connectionId, beforeResetCursor, 25);
  } catch {
    staleCursorRejected = true;
  }
  const newCursorPage = SourceFeedBatchV1Schema.parse(simulator.feed(connectionId, undefined, 25));
  steps.push({
    name: "world_reset_stale_cursor",
    ok: staleCursorRejected && newCursorPage.nextCursor.length > 0,
    detail: "destructive reset rejects old cursor and allows a new checkpoint",
  });

  const managerRecords = new Set(SourceFeedBatchV1Schema.parse(simulator.feed("conn-product-manager", undefined, 100)).records.map((record) => record.sourceId));
  const icRecords = SourceFeedBatchV1Schema.parse(simulator.feed("conn-product-ic", undefined, 100)).records.map((record) => record.sourceId);
  steps.push({
    name: "permission_change_reference",
    ok: icRecords.some((sourceId) => managerRecords.has(sourceId)) && icRecords.length !== managerRecords.size,
    detail: "different connections expose different source visibility",
  });

  const beforeConnections = simulator.connectionIds();
  simulator.regenerateOrganization({ seed: "connector-kit-rotation" });
  const afterConnections = simulator.connectionIds();
  steps.push({
    name: "connection_rotation_reference",
    ok: beforeConnections.includes(connectionId) && afterConnections.includes(connectionId),
    detail: "role alias connection remains available after organization regeneration",
  });

  return {
    schemaVersion: "connector-test-kit.v1",
    generatedAt: new Date().toISOString(),
    connectionId,
    worldRevision: simulator.datasetMetadata().worldRevision,
    steps,
  };
}
