import { createHash } from "node:crypto";
import { z } from "zod";
import { SourceFeedBatchV1Schema, type SourceFeedBatchV1 } from "./contracts.js";
import { scenarios, tenant } from "./data.js";
import {
  sourceSystems,
  type DatasetSize,
  type GeneratedOrganization,
  type OrganizationConfig,
  type Person,
  type ScenarioDefinition,
  type ScenarioEventTemplate,
  type ScenarioRecordTemplate,
  type ScenarioState,
  type Snapshot,
  type SourceChangeType,
  type SourceConnection,
  type SourceRecord,
  type Team,
} from "./domain.js";
import { MemorySimulatorStorage, type SimulatorStorage, type StorageKind } from "./storage.js";
import {
  createConnections,
  defaultOrganizationConfig,
  firstPersonForRole,
  generateOrganization,
  personConnectionId,
  previewOrganizationCounts,
  roleTemplates,
  selectPersonForRole,
} from "./organization.js";

export interface SimulatorOptions {
  seed?: string;
  datasetSize?: DatasetSize;
  baseUrl?: string;
  now?: string;
  storage?: SimulatorStorage;
  organizationConfig?: OrganizationConfig;
}

interface CursorPayload {
  v: 2;
  connectionId: string;
  consumedChangeIds: string[];
  lastSequence: number;
}

interface SourceChange {
  changeId: string;
  sequence: number;
  record: SourceRecord;
}

const CursorPayloadSchema = z
  .object({
    v: z.literal(2),
    connectionId: z.string().min(1).max(200),
    consumedChangeIds: z.array(z.string().min(1).max(220)).max(5_000),
    lastSequence: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const DEFAULT_START_TIME = "2026-07-10T16:00:00.000Z";
const MAX_PAGE_SIZE = 100;
const CHANGE_SEQUENCE_BY_KEY = buildChangeSequenceMap();

export class SourceSimulator {
  private readonly storage: SimulatorStorage;
  private readonly defaultSeed: string;
  private readonly defaultDatasetSize: DatasetSize;
  private readonly baseUrl: string;
  private organizationConfig: OrganizationConfig;
  private organization: GeneratedOrganization;
  private connections: SourceConnection[];

  constructor(options: SimulatorOptions = {}) {
    this.storage = options.storage ?? new MemorySimulatorStorage();
    this.defaultSeed = options.seed ?? "wfo-m1-seed";
    this.defaultDatasetSize = options.datasetSize ?? "small";
    this.baseUrl = options.baseUrl ?? "http://localhost:3000";

    const storedOrganizationConfig = this.storage.getOrganizationConfig();
    this.organizationConfig = cloneOrganizationConfig(
      options.organizationConfig ?? storedOrganizationConfig ?? { ...defaultOrganizationConfig, seed: options.seed ?? defaultOrganizationConfig.seed },
    );
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.connections = createConnections(this.organization);

    for (const scenario of scenarios) {
      if (!this.storage.getScenarioState(scenario.id)) {
        this.storage.saveScenarioState(createInitialState(scenario.id, this.defaultSeed, this.defaultDatasetSize, options.now ?? DEFAULT_START_TIME));
      }
    }
  }

  storageKind(): StorageKind {
    return this.storage.kind;
  }

  publicCatalog() {
    return {
      schemaVersion: "source-simulator-catalog.v1",
      contractVersion: "source-feed.v1",
      tenant: { slug: tenant.slug, name: tenant.name },
      sources: [...new Set(scenarios.flatMap((scenario) => scenario.sourceSystems))],
      scenarios: scenarios.map(({ events, participantRoleTemplateIds, ...scenario }) => ({
        ...scenario,
        eventCount: events.length,
        participantRoleTemplateCount: participantRoleTemplateIds.length,
      })),
      roleTemplateCount: roleTemplates.length,
      organization: {
        departments: Object.keys(this.organization.config.departments),
        totalPeople: this.organization.counts.totalPeople,
        validationOk: this.organization.validation.ok,
      },
    };
  }

  catalog() {
    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      roleTemplates,
      people: this.organization.people,
      teams: this.organization.teams,
      seats: roleTemplates.map((template) => ({ ...template, representativePersonId: firstPersonForRole(this.organization, template.id)?.id ?? null })),
      connections: this.connections,
      sources: [...new Set(scenarios.flatMap((scenario) => scenario.sourceSystems))],
      scenarios: scenarios.map(({ events, ...scenario }) => ({ ...scenario, eventCount: events.length })),
      organization: this.organizationSummary(),
    };
  }

  organizationSummary() {
    return {
      seed: this.organization.seed,
      counts: this.organization.counts,
      validation: this.organization.validation,
      config: this.organization.config,
    };
  }

  organizationTree() {
    return { tree: this.organization.tree };
  }

  people(): Person[] {
    return this.organization.people;
  }

  person(personId: string) {
    const person = this.requirePerson(personId);
    const manager = person.managerId ? this.requirePerson(person.managerId) : null;
    const directReports = person.directReportIds.map((id) => this.requirePerson(id));
    const team = this.requireTeam(person.teamId);
    return { person, manager, directReports, team };
  }

  teams(): Team[] {
    return this.organization.teams;
  }

  team(teamId: string): Team {
    return this.requireTeam(teamId);
  }

  connectionIds(): string[] {
    return this.connections.map((connection) => connection.id);
  }

  hasConnection(connectionId: string): boolean {
    return this.connections.some((connection) => connection.id === connectionId);
  }

  connectionsForAdmin(): SourceConnection[] {
    return this.connections.map((connection) => ({ ...connection, allowedSources: [...connection.allowedSources], allowedGroups: [...connection.allowedGroups] }));
  }

  getOrganizationConfig(): OrganizationConfig {
    return cloneOrganizationConfig(this.organization.config);
  }

  putOrganizationConfig(config: OrganizationConfig) {
    this.organizationConfig = cloneOrganizationConfig({ ...config, seed: config.seed || this.organizationConfig.seed });
    return this.regenerateOrganization({ config: this.organizationConfig });
  }

  regenerateOrganization(input: { seed?: string; config?: OrganizationConfig } = {}) {
    const nextConfig = cloneOrganizationConfig(input.config ?? { ...this.organizationConfig, seed: input.seed ?? this.organizationConfig.seed });
    if (input.seed) nextConfig.seed = input.seed;
    const nextOrganization = buildCompatibleOrganization(nextConfig);
    this.organizationConfig = nextConfig;
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.organization = nextOrganization;
    this.connections = createConnections(this.organization);
    return { organization: this.organizationSummary(), previewCounts: previewOrganizationCounts(this.organizationConfig) };
  }

  resetOrganization() {
    this.organizationConfig = cloneOrganizationConfig(defaultOrganizationConfig);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.connections = createConnections(this.organization);
    return this.organizationSummary();
  }

  recordsForPerson(personId: string) {
    const person = this.requirePerson(personId);
    const connection = this.connections.find((candidate) => candidate.id === personConnectionId(person)) ?? connectionForPerson(person);
    const records = this.allRecords().filter((record) => canConnectionSee(record, connection));
    return { person, connection, records };
  }

  comparePersonVisibility(leftPersonId: string, rightPersonId: string) {
    const left = this.recordsForPerson(leftPersonId);
    const right = this.recordsForPerson(rightPersonId);
    const leftIds = new Set(left.records.map((record) => record.sourceId));
    const rightIds = new Set(right.records.map((record) => record.sourceId));
    return {
      left: left.person,
      right: right.person,
      shared: left.records.filter((record) => rightIds.has(record.sourceId)),
      leftOnly: left.records.filter((record) => !rightIds.has(record.sourceId)),
      rightOnly: right.records.filter((record) => !leftIds.has(record.sourceId)),
    };
  }

  manifest(connectionId: string) {
    const connection = this.requireConnection(connectionId);
    const person = this.requirePerson(connection.personId);
    return {
      schemaVersion: "connection-manifest.v1",
      connectionId,
      tenantSlug: tenant.slug,
      person,
      roleTemplate: roleTemplates.find((template) => template.id === connection.roleTemplateId) ?? null,
      allowedSources: connection.allowedSources,
      allowedGroups: connection.allowedGroups,
      availableScenarios: scenarios.map((scenario) => scenario.id),
    };
  }

  resetScenario(scenarioId: string, input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}): ScenarioState {
    this.requireScenario(scenarioId);
    const state = createInitialState(
      scenarioId,
      input.seed ?? this.defaultSeed,
      input.datasetSize ?? this.defaultDatasetSize,
      input.startTime ?? DEFAULT_START_TIME,
    );
    this.storage.saveScenarioState(state);
    return state;
  }

  advanceScenario(scenarioId: string, input: { hours?: number; days?: number } = {}): ScenarioState {
    const scenario = this.requireScenario(scenarioId);
    const state = this.requireState(scenarioId);
    if (state.paused) return state;
    const hours = clampNumber(input.hours ?? 0, 0, 24 * 365) + clampNumber(input.days ?? 0, 0, 365) * 24;
    const current = new Date(state.currentTime);
    current.setUTCHours(current.getUTCHours() + hours);
    const nextState: ScenarioState = { ...state, currentTime: current.toISOString() };
    this.recordReachedEvents(scenario, nextState);
    this.storage.saveScenarioState(nextState);
    return nextState;
  }

  triggerScenarioEvent(scenarioId: string, eventId: string): ScenarioState {
    const scenario = this.requireScenario(scenarioId);
    const event = scenario.events.find((candidate) => candidate.id === eventId);
    if (!event) throw notFound(`Unknown event: ${eventId}`);
    const state = this.requireState(scenarioId);
    if (!state.triggeredEventIds.includes(event.id)) {
      const nextState = {
        ...state,
        triggeredEventIds: [...state.triggeredEventIds, event.id],
        eventLog: [...state.eventLog, logEntry(scenario.id, event, state.currentTime)],
      };
      this.storage.saveScenarioState(nextState);
      return nextState;
    }
    return state;
  }

  pauseScenario(scenarioId: string): ScenarioState {
    const state = { ...this.requireState(scenarioId), paused: true };
    this.storage.saveScenarioState(state);
    return state;
  }

  resumeScenario(scenarioId: string): ScenarioState {
    const state = { ...this.requireState(scenarioId), paused: false };
    this.storage.saveScenarioState(state);
    return state;
  }

  state(scenarioId: string): ScenarioState {
    return this.requireState(scenarioId);
  }

  states(): ScenarioState[] {
    return this.storage.listScenarioStates();
  }

  eventLog(scenarioId: string) {
    return this.requireState(scenarioId).eventLog;
  }

  allRecords(): SourceRecord[] {
    return scenarios.flatMap((scenario) => this.recordsForScenario(scenario));
  }

  findRecordForConnection(connectionId: string, sourceSystem: string, sourceId: string): SourceRecord {
    const connection = this.requireConnection(connectionId);
    const record = this.allRecords().find((candidate) => candidate.sourceSystem === sourceSystem && candidate.sourceId === sourceId);
    if (!record) throw notFound("Unknown source object");
    if (!canConnectionSee(record, connection)) throw forbidden("Source object is not visible to this connection");
    return record;
  }

  feed(connectionId: string, cursor: string | undefined, limitInput: number | undefined): SourceFeedBatchV1 {
    const connection = this.requireConnection(connectionId);
    const cursorPayload = cursor ? decodeCursor(cursor) : { v: 2 as const, connectionId, consumedChangeIds: [], lastSequence: 0 };
    if (cursorPayload.connectionId !== connectionId) {
      throw badRequest("Cursor does not belong to this connection");
    }
    const limit = Math.min(Math.max(limitInput ?? 50, 1), MAX_PAGE_SIZE);
    const consumed = new Set(cursorPayload.consumedChangeIds);
    const visibleChanges = this.sourceChanges()
      .filter((change) => canConnectionSee(change.record, connection))
      .sort(compareChanges);
    const pending = visibleChanges.filter((change) => !consumed.has(change.changeId));
    const page = pending.slice(0, limit);
    const nextConsumedChangeIds = appendUnique(cursorPayload.consumedChangeIds, page.map((change) => change.changeId));
    const lastSequence = page.at(-1)?.sequence ?? cursorPayload.lastSequence;
    const batch: SourceFeedBatchV1 = {
      schemaVersion: "source-feed.v1",
      connectionId,
      batchId: stableId("batch", connectionId, cursor ?? "initial", String(limit), this.stateFingerprint(), page.map((change) => change.changeId).join(",")),
      generatedAt: maxCurrentTime(this.states()),
      records: page.map((change) => change.record),
      nextCursor: encodeCursor({ v: 2, connectionId, consumedChangeIds: nextConsumedChangeIds, lastSequence }),
      hasMore: pending.length > page.length,
    };
    return SourceFeedBatchV1Schema.parse(batch);
  }

  createSnapshot(): Snapshot {
    const snapshot: Snapshot = {
      snapshotId: stableId("snapshot", this.stateFingerprint()),
      createdAt: maxCurrentTime(this.states()),
      states: this.states(),
      organizationSeed: this.organization.seed,
      organizationConfig: this.organization.config,
    };
    this.storage.createSnapshot(snapshot);
    return snapshot;
  }

  restoreSnapshot(snapshotId: string): Snapshot {
    const snapshot = this.storage.getSnapshot(snapshotId);
    if (!snapshot) throw notFound(`Unknown snapshot: ${snapshotId}`);
    this.storage.replaceScenarioStates(snapshot.states);
    this.organizationConfig = cloneOrganizationConfig(snapshot.organizationConfig);
    this.organization = buildCompatibleOrganization(snapshot.organizationConfig);
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.connections = createConnections(this.organization);
    return snapshot;
  }

  listSnapshots(): Snapshot[] {
    return this.storage.listSnapshots();
  }

  private sourceChanges(): SourceChange[] {
    return scenarios.flatMap((scenario) => this.changesForScenario(scenario)).sort(compareChanges);
  }

  private changesForScenario(scenario: ScenarioDefinition): SourceChange[] {
    const state = this.requireState(scenario.id);
    const elapsed = elapsedHours(state.startedAt, state.currentTime);
    return scenario.events
      .filter((event) => event.atHour <= elapsed || state.triggeredEventIds.includes(event.id))
      .flatMap((event) =>
        event.records.flatMap((template) => {
          const changes = [materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, "created")];
          const mutationAt = template.updatedAfterHours === undefined ? undefined : addHours(addHours(state.startedAt, event.atHour), template.updatedAfterHours);
          if (mutationAt && Date.parse(state.currentTime) >= Date.parse(mutationAt)) {
            changes.push(materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, "updated"));
          }
          return changes.map((record) => ({ changeId: record.changeId, sequence: record.changeSequence, record }));
        }),
      );
  }

  private recordsForScenario(scenario: ScenarioDefinition): SourceRecord[] {
    const state = this.requireState(scenario.id);
    const elapsed = elapsedHours(state.startedAt, state.currentTime);
    return scenario.events
      .filter((event) => event.atHour <= elapsed || state.triggeredEventIds.includes(event.id))
      .flatMap((event) =>
        event.records.map((template) => {
          const occurredAt = addHours(state.startedAt, event.atHour);
          const mutationAt = template.updatedAfterHours === undefined ? undefined : addHours(occurredAt, template.updatedAfterHours);
          const currentChangeType: SourceChangeType = mutationAt && Date.parse(state.currentTime) >= Date.parse(mutationAt) ? "updated" : "created";
          return materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, currentChangeType);
        }),
      );
  }

  private recordReachedEvents(scenario: ScenarioDefinition, state: ScenarioState): void {
    const elapsed = elapsedHours(state.startedAt, state.currentTime);
    for (const event of scenario.events) {
      if (event.atHour <= elapsed && !state.triggeredEventIds.includes(event.id)) {
        state.triggeredEventIds.push(event.id);
        state.eventLog.push(logEntry(scenario.id, event, addHours(state.startedAt, event.atHour)));
      }
    }
  }

  private requireScenario(scenarioId: string): ScenarioDefinition {
    const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw notFound(`Unknown scenario: ${scenarioId}`);
    return scenario;
  }

  private requireState(scenarioId: string): ScenarioState {
    const state = this.storage.getScenarioState(scenarioId);
    if (!state) throw notFound(`Unknown scenario state: ${scenarioId}`);
    return state;
  }

  private requireConnection(connectionId: string): SourceConnection {
    const connection = this.connections.find((candidate) => candidate.id === connectionId);
    if (!connection) throw notFound(`Unknown connection: ${connectionId}`);
    return connection;
  }

  private requirePerson(personId: string): Person {
    const person = this.organization.people.find((candidate) => candidate.id === personId);
    if (!person) throw notFound(`Unknown person: ${personId}`);
    return person;
  }

  private requireTeam(teamId: string): Team {
    const team = this.organization.teams.find((candidate) => candidate.id === teamId);
    if (!team) throw notFound(`Unknown team: ${teamId}`);
    return team;
  }

  private stateFingerprint(): string {
    return stableId("state", JSON.stringify(this.states()), JSON.stringify(this.organization.config));
  }
}

export function validateOrganizationConfigCompatibility(config: OrganizationConfig): string[] {
  return validateGeneratedOrganizationCompatibility(generateOrganization(config));
}

function buildCompatibleOrganization(config: OrganizationConfig): GeneratedOrganization {
  const organization = generateOrganization(config);
  const errors = validateGeneratedOrganizationCompatibility(organization);
  if (errors.length > 0) {
    throw badRequest(`Organization config is incompatible with enabled scenarios: ${errors.join("; ")}`);
  }
  return organization;
}

function validateGeneratedOrganizationCompatibility(organization: GeneratedOrganization): string[] {
  const presentRoleTemplates = new Set(organization.people.map((person) => person.roleTemplateId));
  return [...requiredRoleTemplateIds()]
    .filter((roleTemplateId) => !presentRoleTemplates.has(roleTemplateId))
    .map((roleTemplateId) => `missing required role ${roleTemplateId}`);
}

function requiredRoleTemplateIds(): Set<string> {
  const roleTemplateIds = new Set<string>();
  for (const scenario of scenarios) {
    for (const roleTemplateId of scenario.participantRoleTemplateIds) roleTemplateIds.add(roleTemplateId);
    for (const event of scenario.events) {
      for (const record of event.records) {
        roleTemplateIds.add(record.actorRoleTemplateId);
        if (record.assignmentRoleTemplateId) roleTemplateIds.add(record.assignmentRoleTemplateId);
      }
    }
  }
  return roleTemplateIds;
}

function createInitialState(scenarioId: string, seed: string, datasetSize: DatasetSize, startTime: string): ScenarioState {
  return {
    scenarioId,
    seed,
    datasetSize,
    startedAt: new Date(startTime).toISOString(),
    currentTime: new Date(startTime).toISOString(),
    paused: false,
    triggeredEventIds: [],
    eventLog: [],
  };
}

function materializeRecord(
  baseUrl: string,
  state: ScenarioState,
  scenario: ScenarioDefinition,
  event: ScenarioEventTemplate,
  template: ScenarioRecordTemplate,
  organization: GeneratedOrganization,
  changeType: SourceChangeType,
): SourceRecord {
  const occurredAt = addHours(state.startedAt, event.atHour);
  const sourceId = stableId(template.sourceSystem, state.seed, organization.seed, scenario.id, event.id, template.id);
  const mutationAt = template.updatedAfterHours === undefined ? undefined : addHours(occurredAt, template.updatedAfterHours);
  const isUpdatedChange = changeType === "updated";
  const changeOccurredAt = isUpdatedChange && mutationAt ? mutationAt : occurredAt;
  const actor = selectPersonForRole(organization, template.actorRoleTemplateId, `${scenario.id}:${event.id}:${template.id}:actor`);
  const assignee = template.assignmentRoleTemplateId
    ? selectPersonForRole(organization, template.assignmentRoleTemplateId, `${scenario.id}:${event.id}:${template.id}:assignee`)
    : null;
  const rawPayload: Record<string, unknown> = {
    ...template.rawPayload,
    simulatorSourceId: sourceId,
    scenarioTime: occurredAt,
    actorPersonId: actor.id,
    actorEmail: actor.email,
    assigneePersonId: assignee?.id ?? null,
    assigneeEmail: assignee?.email ?? null,
    simulatorVersion: isUpdatedChange ? "updated" : "initial",
  };
  if (isUpdatedChange && mutationAt) rawPayload.simulatorUpdatedAt = mutationAt;

  const changeSequence = sequenceForChange(scenario, event, template, changeType);
  const record: SourceRecord = {
    schemaVersion: "source-record.v1",
    sourceSystem: template.sourceSystem,
    sourceId,
    objectType: template.objectType,
    occurredAt,
    title: template.title,
    sourceUrl: `${baseUrl}/sim/${template.sourceSystem}/${sourceId}`,
    actorRef: actor.id,
    acl: template.acl,
    rawPayload,
    changeId: stableId("change", sourceId, changeType),
    changeType,
    changeSequence,
    changeOccurredAt,
    correlation: {
      scenarioId: scenario.id,
      eventId: event.id,
      templateId: template.id,
      seedFingerprint: stableId("seed", state.seed, organization.seed),
    },
  };
  if (isUpdatedChange && mutationAt) record.updatedAt = mutationAt;
  return record;
}

function canConnectionSee(record: SourceRecord, connection: SourceConnection): boolean {
  if (!connection.allowedSources.includes(record.sourceSystem)) return false;
  if (record.acl.visibility === "public") return true;
  if (record.acl.users.includes(connection.personId)) return true;
  return record.acl.groups.some((group) => connection.allowedGroups.includes(group));
}

function connectionForPerson(person: Person): SourceConnection {
  return {
    id: personConnectionId(person),
    tenantId: tenant.id,
    personId: person.id,
    roleTemplateId: person.roleTemplateId,
    label: `${person.name} (${person.roleTitle}) simulator connection`,
    allowedSources: [...sourceSystems],
    allowedGroups: [...person.groupMemberships],
  };
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    return CursorPayloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw badRequest("Invalid cursor");
  }
}

function appendUnique(existing: string[], additions: string[]): string[] {
  const result = [...existing];
  const seen = new Set(result);
  for (const addition of additions) {
    if (!seen.has(addition)) {
      result.push(addition);
      seen.add(addition);
    }
  }
  return result;
}

function compareChanges(left: SourceChange, right: SourceChange): number {
  return left.sequence - right.sequence || left.changeId.localeCompare(right.changeId);
}

function elapsedHours(start: string, end: string): number {
  return Math.floor((Date.parse(end) - Date.parse(start)) / 3_600_000);
}

function addHours(start: string, hours: number): string {
  const date = new Date(start);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function maxCurrentTime(states: ScenarioState[]): string {
  return states.map((state) => state.currentTime).sort().at(-1) ?? new Date(DEFAULT_START_TIME).toISOString();
}

function logEntry(scenarioId: string, event: ScenarioEventTemplate, occurredAt: string) {
  return {
    scenarioId,
    eventId: event.id,
    label: event.label,
    occurredAt,
    recordTemplateIds: event.records.map((record) => record.id),
  };
}

function sequenceForChange(
  scenario: ScenarioDefinition,
  event: ScenarioEventTemplate,
  template: ScenarioRecordTemplate,
  changeType: SourceChangeType,
): number {
  const sequence = CHANGE_SEQUENCE_BY_KEY.get(changeKey(scenario.id, event.id, template.id, changeType));
  if (!sequence) throw new Error(`Missing deterministic change sequence for ${scenario.id}/${event.id}/${template.id}/${changeType}`);
  return sequence;
}

function buildChangeSequenceMap(): Map<string, number> {
  const changes: Array<{ key: string; orderTime: number; scenarioId: string; eventId: string; templateId: string; changeType: SourceChangeType }> = [];
  for (const scenario of scenarios) {
    for (const event of scenario.events) {
      for (const template of event.records) {
        changes.push({ key: changeKey(scenario.id, event.id, template.id, "created"), orderTime: event.atHour, scenarioId: scenario.id, eventId: event.id, templateId: template.id, changeType: "created" });
        if (template.updatedAfterHours !== undefined) {
          changes.push({
            key: changeKey(scenario.id, event.id, template.id, "updated"),
            orderTime: event.atHour + template.updatedAfterHours,
            scenarioId: scenario.id,
            eventId: event.id,
            templateId: template.id,
            changeType: "updated",
          });
        }
      }
    }
  }
  changes.sort(
    (left, right) =>
      left.orderTime - right.orderTime ||
      left.scenarioId.localeCompare(right.scenarioId) ||
      left.eventId.localeCompare(right.eventId) ||
      left.templateId.localeCompare(right.templateId) ||
      left.changeType.localeCompare(right.changeType),
  );
  return new Map(changes.map((change, index) => [change.key, index + 1]));
}

function changeKey(scenarioId: string, eventId: string, templateId: string, changeType: SourceChangeType): string {
  return `${scenarioId}:${eventId}:${templateId}:${changeType}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function cloneOrganizationConfig(config: OrganizationConfig): OrganizationConfig {
  return JSON.parse(JSON.stringify(config)) as OrganizationConfig;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}
