import { z } from "zod";

export const AclSchema = z.object({
  visibility: z.enum(["public", "group", "restricted", "private"]),
  groups: z.array(z.string()),
  users: z.array(z.string()),
});

export const SourceRecordSchema = z.object({
  schemaVersion: z.literal("source-record.v1"),
  sourceSystem: z.string(),
  sourceId: z.string().min(1),
  objectType: z.string().min(1),
  occurredAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  title: z.string(),
  sourceUrl: z.string(),
  actorRef: z.string().optional(),
  acl: AclSchema,
  rawPayload: z.record(z.unknown()),
  changeId: z.string().min(1),
  changeType: z.enum(["created", "updated", "deleted"]),
  changeSequence: z.number().int().min(1),
  changeOccurredAt: z.string().datetime(),
  correlation: z.object({
    scenarioId: z.string(),
    eventId: z.string(),
    templateId: z.string(),
    seedFingerprint: z.string(),
  }),
});

export const SourceFeedBatchV1Schema = z.object({
  schemaVersion: z.literal("source-feed.v1"),
  cursorVersion: z.literal(3),
  worldRevision: z.string().min(1),
  connectionId: z.string().min(1),
  batchId: z.string().min(1),
  generatedAt: z.string().datetime(),
  records: z.array(SourceRecordSchema),
  nextCursor: z.string().min(1),
  hasMore: z.boolean(),
});

export type SourceFeedBatchV1 = z.infer<typeof SourceFeedBatchV1Schema>;

export const SourceChangeLedgerEntrySchema = z.object({
  ledgerSequence: z.number().int().min(1),
  worldRevision: z.string().min(1),
  changeId: z.string().min(1),
  changeType: z.enum(["created", "updated", "deleted"]),
  sourceSystem: z.string().min(1),
  sourceId: z.string().min(1),
  changeOccurredAt: z.string().datetime(),
  sourceOccurredAt: z.string().datetime(),
  scenarioId: z.string().min(1),
  scenarioPackId: z.string().min(1),
  scenarioInstanceId: z.string().min(1),
  businessEventId: z.string().min(1),
  templateId: z.string().min(1),
  record: SourceRecordSchema,
  permissionScope: AclSchema,
});

export const SourceObjectProjectionSchema = z.object({
  sourceKey: z.string().min(1),
  worldRevision: z.string().min(1),
  sourceSystem: z.string().min(1),
  sourceId: z.string().min(1),
  currentChangeId: z.string().min(1),
  currentChangeType: z.enum(["created", "updated", "deleted"]),
  record: SourceRecordSchema,
});

export const WorkforceOneSnapshotV1Schema = z.object({
  schemaVersion: z.literal("workforce-one-snapshot.v1"),
  contractVersion: z.string().min(1),
  exportedAt: z.string().datetime(),
  tenant: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
  }),
  worldRevision: z.string().min(1),
  datasetMetadata: z.record(z.unknown()),
  organization: z.object({
    seed: z.string().min(1),
    config: z.record(z.unknown()),
    counts: z.record(z.unknown()),
    validation: z.record(z.unknown()),
    roleTemplates: z.array(z.record(z.unknown())),
    people: z.array(z.record(z.unknown())),
    teams: z.array(z.record(z.unknown())),
    reportingRelationships: z.array(z.record(z.unknown())),
    tree: z.array(z.record(z.unknown())),
  }),
  connections: z.array(
    z.object({
      id: z.string().min(1),
      tenantId: z.string().min(1),
      personId: z.string().min(1),
      roleTemplateId: z.string().min(1),
      label: z.string().min(1),
      allowedSources: z.array(z.string().min(1)),
      allowedGroups: z.array(z.string()),
      checkpoint: z.object({
        cursorVersion: z.literal(3),
        worldRevision: z.string().min(1),
        afterSequence: z.number().int().min(0),
        cursor: z.string().min(1),
      }),
      visibility: z.object({
        visibleSourceObjectCount: z.number().int().min(0),
        visibleSourceChangeCount: z.number().int().min(0),
        visibleSourceKeysHash: z.string().min(1),
        visibleLedgerSequencesHash: z.string().min(1),
      }),
    }),
  ),
  sourceObjects: z.array(SourceObjectProjectionSchema),
  sourceChanges: z.array(SourceChangeLedgerEntrySchema),
  counts: z.object({
    people: z.number().int().min(0),
    teams: z.number().int().min(0),
    roleTemplates: z.number().int().min(0),
    connections: z.number().int().min(0),
    roleAliasConnections: z.number().int().min(0),
    personConnections: z.number().int().min(0),
    sourceObjects: z.number().int().min(0),
    sourceChanges: z.number().int().min(0),
    bySourceSystem: z.record(z.number().int().min(0)),
  }),
  integrity: z.object({
    organizationHash: z.string().min(1),
    connectionsHash: z.string().min(1),
    sourceObjectsHash: z.string().min(1),
    sourceChangesHash: z.string().min(1),
    snapshotHash: z.string().min(1),
  }),
});

export type WorkforceOneSnapshotV1 = z.infer<typeof WorkforceOneSnapshotV1Schema>;
