import { z } from "zod";
import type { SourceFeedBatchV1 } from "./contracts.js";

const FailureModeSchema = z.enum([
  "rate_limit",
  "timeout",
  "service_unavailable",
  "internal_error",
  "network_latency",
  "partial_page",
  "cursor_corruption",
  "auth_failure",
  "expired_credentials",
  "provider_outage",
  "malformed_payload",
  "permission_changes",
  "deleted_objects",
  "edited_objects",
  "late_arriving_objects",
  "duplicate_objects",
  "stale_objects",
]);

const FailureRuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    enabled: z.boolean().default(true),
    mode: FailureModeSchema,
    operation: z.string().min(1).max(80).optional(),
    connectionId: z.string().min(1).max(200).optional(),
    sourceSystem: z.string().min(1).max(80).optional(),
    everyNth: z.number().int().min(1).max(10_000).optional(),
    latencyMs: z.number().int().min(0).max(30_000).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    status: z.number().int().min(400).max(599).optional(),
    message: z.string().min(1).max(200).optional(),
  })
  .strict();

export const FailureModeConfigSchema = z
  .object({
    schemaVersion: z.literal("failure-modes.v1").default("failure-modes.v1"),
    rules: z.array(FailureRuleSchema).max(100).default([]),
  })
  .strict();

export type FailureModeConfig = z.infer<typeof FailureModeConfigSchema>;
export type FailureRule = z.infer<typeof FailureRuleSchema>;

export interface FailureContext {
  operation: string;
  connectionId?: string;
  sourceSystem?: string;
}

export interface FailureDecision {
  latencyMs?: number;
  errorStatus?: number;
  errorClassification?: string;
  message?: string;
  pageSize?: number;
  corruptCursor?: boolean;
  malformedPayload?: boolean;
  duplicateObject?: boolean;
  staleObject?: boolean;
  permissionChange?: boolean;
  deletedObject?: boolean;
  editedObject?: boolean;
  lateArrivingObject?: boolean;
}

export class FailureController {
  private config: FailureModeConfig = { schemaVersion: "failure-modes.v1", rules: [] };
  private readonly counters = new Map<string, number>();

  getConfig(): FailureModeConfig {
    return JSON.parse(JSON.stringify(this.config)) as FailureModeConfig;
  }

  setConfig(input: unknown): FailureModeConfig {
    this.config = FailureModeConfigSchema.parse(input);
    this.counters.clear();
    return this.getConfig();
  }

  reset(): FailureModeConfig {
    this.config = { schemaVersion: "failure-modes.v1", rules: [] };
    this.counters.clear();
    return this.getConfig();
  }

  evaluate(context: FailureContext): FailureDecision {
    const decision: FailureDecision = {};
    for (const rule of this.config.rules) {
      if (!matchesRule(rule, context)) continue;
      const count = this.incrementRule(rule.id);
      if (rule.everyNth && count % rule.everyNth !== 0) continue;
      applyRule(decision, rule);
    }
    return decision;
  }

  private incrementRule(id: string): number {
    const next = (this.counters.get(id) ?? 0) + 1;
    this.counters.set(id, next);
    return next;
  }
}

export function applyFeedFailure(batch: SourceFeedBatchV1, decision: FailureDecision): SourceFeedBatchV1 {
  const next = JSON.parse(JSON.stringify(batch)) as SourceFeedBatchV1;
  if (decision.pageSize !== undefined) {
    next.records = next.records.slice(0, decision.pageSize);
    next.hasMore = batch.records.length > next.records.length || batch.hasMore;
  }
  if (decision.permissionChange) {
    next.records = [];
    next.hasMore = false;
  }
  if (decision.duplicateObject && next.records[0]) {
    next.records = [next.records[0], ...next.records];
  }
  if (decision.staleObject && next.records[0]) {
    next.generatedAt = next.records[0].occurredAt;
  }
  if (decision.malformedPayload && next.records[0]) {
    delete (next.records[0].rawPayload as Record<string, unknown>).actor;
    (next.records[0].rawPayload as Record<string, unknown>).simulatorMalformedPayload = true;
  }
  if (decision.deletedObject && next.records[0]) {
    next.records[0].changeType = "deleted";
    (next.records[0].rawPayload as Record<string, unknown>).simulatorDeletedObject = true;
  }
  if (decision.editedObject && next.records[0]) {
    next.records[0].title = `${next.records[0].title} (simulated edit)`;
    (next.records[0].rawPayload as Record<string, unknown>).simulatorEditedObject = true;
  }
  if (decision.lateArrivingObject && next.records[0]) {
    next.records[0].occurredAt = backdateIso(next.records[0].occurredAt, 48);
    next.records[0].changeOccurredAt = next.generatedAt;
    (next.records[0].rawPayload as Record<string, unknown>).simulatorLateArrivingObject = true;
  }
  if (decision.corruptCursor) {
    next.nextCursor = "corrupted-cursor-for-failure-test";
  }
  return next;
}

export function parseFailureConfig(value: string | undefined): FailureModeConfig {
  if (!value?.trim()) return { schemaVersion: "failure-modes.v1", rules: [] };
  return FailureModeConfigSchema.parse(JSON.parse(value) as unknown);
}

function matchesRule(rule: FailureRule, context: FailureContext): boolean {
  if (!rule.enabled) return false;
  if (rule.operation && rule.operation !== context.operation) return false;
  if (rule.connectionId && rule.connectionId !== context.connectionId) return false;
  if (rule.sourceSystem && rule.sourceSystem !== context.sourceSystem) return false;
  return true;
}

function applyRule(decision: FailureDecision, rule: FailureRule): void {
  if (rule.mode === "network_latency") decision.latencyMs = Math.max(decision.latencyMs ?? 0, rule.latencyMs ?? 250);
  if (rule.mode === "timeout") {
    decision.latencyMs = Math.max(decision.latencyMs ?? 0, rule.latencyMs ?? 1_000);
    decision.errorStatus = rule.status ?? 504;
    decision.errorClassification = "timeout";
    decision.message = rule.message ?? "Simulated provider timeout";
  }
  if (rule.mode === "rate_limit") {
    decision.errorStatus = rule.status ?? 429;
    decision.errorClassification = "rate_limit";
    decision.message = rule.message ?? "Simulated rate limit";
  }
  if (rule.mode === "service_unavailable" || rule.mode === "provider_outage") {
    decision.errorStatus = rule.status ?? 503;
    decision.errorClassification = rule.mode;
    decision.message = rule.message ?? "Simulated provider outage";
  }
  if (rule.mode === "internal_error") {
    decision.errorStatus = rule.status ?? 500;
    decision.errorClassification = "internal_error";
    decision.message = rule.message ?? "Simulated provider error";
  }
  if (rule.mode === "auth_failure" || rule.mode === "expired_credentials") {
    decision.errorStatus = rule.status ?? 401;
    decision.errorClassification = rule.mode;
    decision.message = rule.message ?? "Simulated authentication failure";
  }
  if (rule.mode === "partial_page") decision.pageSize = Math.min(decision.pageSize ?? Number.POSITIVE_INFINITY, rule.pageSize ?? 1);
  if (rule.mode === "cursor_corruption") decision.corruptCursor = true;
  if (rule.mode === "malformed_payload") decision.malformedPayload = true;
  if (rule.mode === "permission_changes") decision.permissionChange = true;
  if (rule.mode === "deleted_objects") decision.deletedObject = true;
  if (rule.mode === "edited_objects") decision.editedObject = true;
  if (rule.mode === "late_arriving_objects") decision.lateArrivingObject = true;
  if (rule.mode === "duplicate_objects") decision.duplicateObject = true;
  if (rule.mode === "stale_objects") decision.staleObject = true;
}

function backdateIso(value: string, hours: number): string {
  const date = new Date(value);
  date.setUTCHours(date.getUTCHours() - hours);
  return date.toISOString();
}
