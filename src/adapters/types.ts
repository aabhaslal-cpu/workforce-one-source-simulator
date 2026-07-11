import type {
  GeneratedOrganization,
  Person,
  ScenarioDefinition,
  ScenarioEventTemplate,
  ScenarioInstanceContext,
  ScenarioRecordTemplate,
  ScenarioState,
  SourceChangeType,
  SourceSystem,
} from "../domain.js";

export interface SourceEmissionInput {
  baseUrl: string;
  sourceId: string;
  occurredAt: string;
  changeOccurredAt: string;
  changeType: SourceChangeType;
  scenario: ScenarioDefinition;
  event: ScenarioEventTemplate;
  template: ScenarioRecordTemplate;
  state: ScenarioState;
  instance: ScenarioInstanceContext;
  organization: GeneratedOrganization;
  actor: Person;
  assignee: Person | null;
  managerChain: Person[];
}

export interface SourceChangeDraft {
  sourceUrl: string;
  rawPayload: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface SourceAdapter {
  sourceSystem: SourceSystem;
  supportedObjectTypes: string[];
  create(input: SourceEmissionInput): SourceChangeDraft;
  update(input: SourceEmissionInput): SourceChangeDraft;
  remove(input: SourceEmissionInput): SourceChangeDraft;
  validatePayload(payload: unknown): ValidationResult;
  buildSourceUrl(input: Pick<SourceEmissionInput, "baseUrl" | "sourceId">): string;
}
