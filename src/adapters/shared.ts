import type { SourceAdapter, SourceChangeDraft, SourceEmissionInput, ValidationResult } from "./types.js";

export function simulatorDeepLink(sourceSystem: string, baseUrl: string, sourceId: string): string {
  return `${baseUrl}/sim/${sourceSystem}/${sourceId}`;
}

export function validateRecordPayload(sourceSystem: string, payload: unknown): ValidationResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: [`${sourceSystem} payload must be an object`] };
  }
  const candidate = payload as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of ["provider", "sourceId", "objectType", "actor", "lifecycle"]) {
    if (!(key in candidate)) errors.push(`${sourceSystem} payload missing ${key}`);
  }
  return { ok: errors.length === 0, errors };
}

export function personPayload(person: SourceEmissionInput["actor"]) {
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    roleTitle: person.roleTitle,
    department: person.department,
    teamId: person.teamId,
  };
}

export function isPerson(person: SourceEmissionInput["actor"] | null | undefined): person is SourceEmissionInput["actor"] {
  return person !== null && person !== undefined;
}

export function commonPayload(sourceSystem: string, input: SourceEmissionInput, providerFields: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: sourceSystem,
    sourceId: input.sourceId,
    objectType: input.template.objectType,
    lifecycle: lifecycleFor(input.changeType),
    title: input.template.title,
    summary: input.template.rawPayload.summary ?? input.template.title,
    scenarioPackId: input.scenario.id,
    scenarioInstanceId: input.instance.scenarioInstanceId,
    businessEventId: input.event.id,
    occurredAt: input.occurredAt,
    changeOccurredAt: input.changeOccurredAt,
    actor: personPayload(input.actor),
    assignee: input.assignee ? personPayload(input.assignee) : null,
    managementChain: input.managerChain.map(personPayload),
    account: input.template.rawPayload.account ?? input.instance.account ?? null,
    product: input.template.rawPayload.product ?? input.instance.product ?? null,
    project: input.template.rawPayload.project ?? input.instance.project ?? null,
    service: input.template.rawPayload.service ?? input.instance.service ?? null,
    workstream: input.template.rawPayload.workstream ?? input.instance.workstream ?? null,
    providerFields,
    context: input.template.rawPayload,
  };
}

export function adapterDraft(sourceSystem: string, input: SourceEmissionInput, providerFields: Record<string, unknown>): SourceChangeDraft {
  return {
    sourceUrl: simulatorDeepLink(sourceSystem, input.baseUrl, input.sourceId),
    rawPayload: commonPayload(sourceSystem, input, providerFields),
  };
}

export function lifecycleFor(changeType: SourceEmissionInput["changeType"]): string {
  if (changeType === "deleted") return "deleted";
  if (changeType === "updated") return "updated";
  return "active";
}

export function statusFor(input: SourceEmissionInput, fallback: string): string {
  if (input.changeType === "deleted") return "deleted";
  if (input.changeType === "updated") return String(input.template.rawPayload.updatedStatus ?? input.template.rawPayload.status ?? fallback);
  return String(input.template.rawPayload.status ?? fallback);
}

export function makeSimpleAdapter(
  sourceSystem: SourceAdapter["sourceSystem"],
  supportedObjectTypes: string[],
  fields: (input: SourceEmissionInput) => Record<string, unknown>,
): SourceAdapter {
  return {
    sourceSystem,
    supportedObjectTypes,
    create: (input) => adapterDraft(sourceSystem, input, fields(input)),
    update: (input) => adapterDraft(sourceSystem, input, fields(input)),
    remove: (input) => adapterDraft(sourceSystem, input, { ...fields(input), deleted: true, tombstone: true }),
    validatePayload: (payload) => validateRecordPayload(sourceSystem, payload),
    buildSourceUrl: (input) => simulatorDeepLink(sourceSystem, input.baseUrl, input.sourceId),
  };
}
