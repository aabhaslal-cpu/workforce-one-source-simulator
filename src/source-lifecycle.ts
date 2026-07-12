import type { SourceChangeLedgerEntry, SourceRecord, SourceSystem } from "./domain.js";
import { canonicalPayloadFamily } from "./adapters/vendor-schemas.js";

export function providerDeleteReturnsNoBody(
  sourceSystem: SourceSystem,
  objectType: string,
): boolean {
  const family = canonicalPayloadFamily(sourceSystem, objectType);
  return (
    (sourceSystem === "gmail" && (family === "message" || family === "thread")) ||
    (sourceSystem === "productboard" && (family === "feature" || family === "note")) ||
    (sourceSystem === "github" && family === "release")
  );
}

export function preserveNoBodyDeletionPayloads(
  orderedChanges: SourceChangeLedgerEntry[],
): SourceChangeLedgerEntry[] {
  const currentBySource = new Map<string, SourceChangeLedgerEntry>();
  return orderedChanges.map((change) => {
    const key = `${change.sourceSystem}:${change.sourceId}`;
    const previous = currentBySource.get(key);
    const next =
      change.changeType === "deleted" &&
      providerDeleteReturnsNoBody(change.sourceSystem, change.record.objectType)
        ? preservePreviousPayload(change, previous)
        : change;
    currentBySource.set(key, next);
    return next;
  });
}

function preservePreviousPayload(
  deletion: SourceChangeLedgerEntry,
  previous: SourceChangeLedgerEntry | undefined,
): SourceChangeLedgerEntry {
  if (!previous) {
    throw new Error(
      `Cannot preserve last-known payload for ${deletion.sourceSystem}:${deletion.sourceId}; no previous source object exists`,
    );
  }
  const record: SourceRecord = {
    ...deletion.record,
    objectType: previous.record.objectType,
    rawPayload: cloneJson(previous.record.rawPayload),
  };
  if (previous.record.updatedAt === undefined) delete record.updatedAt;
  else record.updatedAt = previous.record.updatedAt;
  return {
    ...deletion,
    record,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
