import { createHash } from "node:crypto";
import { SourceFeedBatchV1Schema, type SourceFeedBatchV1 } from "./contracts.js";
import { scenarios, tenant } from "./data.js";
import type {
  DatasetSize,
  GeneratedOrganization,
  OrganizationConfig,
  Person,
  ScenarioDefinition,
  ScenarioEventTemplate,
  ScenarioState,
  Snapshot,
  SourceConnection,
  SourceRecord,
  Team,
} from "./domain.js";
import { MemorySimulatorStorage, type SimulatorStorage } from "./storage.js";
import {
  createConnections,
  defaultOrganizationConfig,
  firstPersonForRole,
  generateOrganization,
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
  v: 1;
  connectionId: string;
  offset: number;
}

const DEFAULT_START_TIME = "2026-07-10T16:00:00.000Z";

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
    this.organizationConfig = options.organizationConfig ?? { ...defaultOrganizationConfig, seed: options.seed ?? defaultOrganizationConfig.seed };
    this.organization = generateOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);

    for (const scenario of scenarios) {
      if (!this.storage.getScenarioState(scenario.id)) {
        this.storage.saveScenarioState(createInitialState(scenario.id, this.defaultSeed, this.defaultDatasetSize, options.now ?? DEFAULT_START_TIME));
      }
    }
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

  getOrganizationConfig(): OrganizationConfig {
    return this.organization.config;
  }

  putOrganizationConfig(config: OrganizationConfig) {
    this.organizationConfig = { ...config, seed: config.seed || this.organizationConfig.seed };
    return this.regenerateOrganization({ config: this.organizationConfig });
  }

  regenerateOrganization(input: { seed?: string; config?: OrganizationConfig } = {}) {
    this.organizationConfig = input.config ?? { ...this.organizationConfig, seed: input.seed ?? this.organizationConfig.seed };
    if (input.seed) this.organizationConfig = { ...this.organizationConfig, seed: input.seed };
    this.organization = generateOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
    return { organization: this.organizationSummary(), previewCounts: previewOrganizationCounts(this.organizationConfig) };
  }

  resetOrganization() {
    this.organizationConfig = defaultOrganizationConfig;
    this.organization = generateOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
    return this.organizationSummary();
  }

  recordsForPerson(personId: string) {
    const person = this.requirePerson(personId);
    const connection = this.connections.find((candidate) => candidate.id === `conn-${person.id}`) ?? connectionForPerson(person);
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

  feed(connectionId: string, cursor: string | undefined, limitInput: number | undefined): SourceFeedBatchV1 {
    const connection = this.requireConnection(connectionId);
    const cursorPayload = cursor ? decodeCursor(cursor) : { v: 1 as const, connectionId, offset: 0 };
    if (cursorPayload.connectionId !== connectionId) {
      throw badRequest("Cursor does not belong to this connection");
    }
    const limit = Math.min(Math.max(limitInput ?? 50, 1), 250);
    const visible = this.allRecords()
      .filter((record) => canConnectionSee(record, connection))
      .sort(compareRecords);
    const page = visible.slice(cursorPayload.offset, cursorPayload.offset + limit);
    const nextOffset = cursorPayload.offset + page.length;
    const hasMore = nextOffset < visible.length;
    const batch: SourceFeedBatchV1 = {
      schemaVersion: "source-feed.v1",
      connectionId,
      batchId: stableId("batch", connectionId, String(cursorPayload.offset), String(limit), this.stateFingerprint()),
      generatedAt: maxCurrentTime(this.states()),
      records: page,
      nextCursor: hasMore ? encodeCursor({ v: 1, connectionId, offset: nextOffset }) : null,
      hasMore,
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
    this.organizationConfig = snapshot.organizationConfig;
    this.organization = generateOrganization(snapshot.organizationConfig);
    this.connections = createConnections(this.organization);
    return snapshot;
  }

  listSnapshots(): Snapshot[] {
    return this.storage.listSnapshots();
  }

  private recordsForScenario(scenario: ScenarioDefinition): SourceRecord[] {
    const state = this.requireState(scenario.id);
    const elapsed = elapsedHours(state.startedAt, state.currentTime);
    return scenario.events
      .filter((event) => event.atHour <= elapsed || state.triggeredEventIds.includes(event.id))
      .flatMap((event) => event.records.map((template) => materializeRecord(this.baseUrl, state, scenario, event, template, this.organization)));
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
  template: ScenarioEventTemplate["records"][number],
  organization: GeneratedOrganization,
): SourceRecord {
  const occurredAt = addHours(state.startedAt, event.atHour);
  const sourceId = stableId(template.sourceSystem, state.seed, organization.seed, scenario.id, event.id, template.id);
  const updatedAt = template.updatedAfterHours === undefined ? undefined : addHours(occurredAt, template.updatedAfterHours);
  const actor = selectPersonForRole(organization, template.actorRoleTemplateId, `${scenario.id}:${event.id}:${template.id}:actor`);
  const assignee = template.assignmentRoleTemplateId
    ? selectPersonForRole(organization, template.assignmentRoleTemplateId, `${scenario.id}:${event.id}:${template.id}:assignee`)
    : null;
  return removeUndefined({
    schemaVersion: "source-record.v1" as const,
    sourceSystem: template.sourceSystem,
    sourceId,
    objectType: template.objectType,
    occurredAt,
    updatedAt,
    title: template.title,
    sourceUrl: `${baseUrl}/sim/${template.sourceSystem}/${sourceId}`,
    actorRef: actor.id,
    acl: template.acl,
    rawPayload: {
      ...template.rawPayload,
      simulatorSourceId: sourceId,
      scenarioTime: occurredAt,
      actorPersonId: actor.id,
      actorEmail: actor.email,
      assigneePersonId: assignee?.id ?? null,
      assigneeEmail: assignee?.email ?? null,
    },
    correlation: {
      scenarioId: scenario.id,
      eventId: event.id,
      templateId: template.id,
      seedFingerprint: stableId("seed", state.seed, organization.seed),
    },
  });
}

function canConnectionSee(record: SourceRecord, connection: SourceConnection): boolean {
  if (!connection.allowedSources.includes(record.sourceSystem)) return false;
  if (record.acl.visibility === "public") return true;
  if (record.acl.users.includes(connection.personId)) return true;
  return record.acl.groups.some((group) => connection.allowedGroups.includes(group));
}

function connectionForPerson(person: Person): SourceConnection {
  return {
    id: `conn-${person.id}`,
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
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (parsed.v !== 1 || typeof parsed.connectionId !== "string" || typeof parsed.offset !== "number") {
      throw new Error("Invalid cursor shape");
    }
    return parsed;
  } catch {
    throw badRequest("Invalid cursor");
  }
}

function compareRecords(left: SourceRecord, right: SourceRecord): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.sourceSystem.localeCompare(right.sourceSystem) || left.sourceId.localeCompare(right.sourceId);
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

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
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

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}
