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
  correlation: z.object({
    scenarioId: z.string(),
    eventId: z.string(),
    templateId: z.string(),
    seedFingerprint: z.string(),
  }),
});

export const SourceFeedBatchV1Schema = z.object({
  schemaVersion: z.literal("source-feed.v1"),
  connectionId: z.string().min(1),
  batchId: z.string().min(1),
  generatedAt: z.string().datetime(),
  records: z.array(SourceRecordSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type SourceFeedBatchV1 = z.infer<typeof SourceFeedBatchV1Schema>;
