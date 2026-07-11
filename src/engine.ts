import { createHash } from "node:crypto";
import { z } from "zod";
import { requireSourceAdapter } from "./adapters/registry.js";
import { SourceFeedBatchV1Schema, type SourceFeedBatchV1 } from "./contracts.js";
import { scenarios, tenant } from "./data.js";
import {
  type DatasetMetadata,
  sourceSystems,
  type DatasetSize,
  type GeneratedOrganization,
  type OrganizationConfig,
  type Person,
  type ScenarioDefinition,
  type ScenarioEventTemplate,
  type ScenarioInstanceContext,
  type ScenarioInstanceState,
  type ScenarioRecordTemplate,
  type Snapshot,
  type SourceChangeLedgerEntry,
  type SourceChangeType,
  type SourceConnection,
  type SourceObjectProjection,
  type SourceRecord,
  type Team,
} from "./domain.js";
import { MemorySimulatorStorage, type SimulatorStorage, type StorageHealth, type StorageKind } from "./storage.js";
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
  v: 3;
  connectionId: string;
  worldRevision: string;
  afterSequence: number;
}

const CursorPayloadSchema = z
  .object({
    v: z.literal(3),
    connectionId: z.string().min(1).max(200),
    worldRevision: z.string().min(1).max(128),
    afterSequence: z.number().int().min(0).max(10_000_000),
  })
  .strict();

const DEFAULT_START_TIME = "2026-07-10T16:00:00.000Z";
const MAX_PAGE_SIZE = 100;
const INSTANCE_COUNTS: Record<DatasetSize, number> = { small: 1, medium: 8, large: 40 };
const INSTANCE_SPANS_HOURS: Record<DatasetSize, number> = { small: 0, medium: 24 * 25, large: 24 * 85 };
const DATASET_DURATION_HOURS: Record<DatasetSize, number> = { small: 24 * 7, medium: 24 * 30, large: 24 * 90 };
const INSTANCE_ACCOUNTS = ["Northstar Medical", "Summit Foods", "Cobalt Bank", "Beacon Retail", "Atlas Logistics", "Pioneer Health"];
const INSTANCE_PRODUCTS = ["Workflow Hub", "Operations Control", "Connector Gateway", "Analytics Studio", "Customer Console", "Identity Fabric"];
const INSTANCE_PROJECTS = ["Aurora", "Beacon", "Comet", "Delta", "Evergreen", "Foundry"];
const INSTANCE_SERVICES = ["ingestion", "workflow-export", "identity", "analytics", "notifications", "audit-stream"];

export interface ScenarioInstanceCreateInput {
  scenarioPackId: string;
  scenarioInstanceId?: string;
  seed?: string;
  datasetSize?: DatasetSize;
  startTime?: string;
  account?: string;
  product?: string;
  project?: string;
  service?: string;
  workstream?: string;
  participantPersonIds?: Record<string, string>;
}

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

    let instanceStates = this.storage.listScenarioInstanceStates();
    if (instanceStates.length === 0) {
      instanceStates = createDatasetInstanceStates(
        this.organization,
        this.defaultSeed,
        this.defaultDatasetSize,
        options.now ?? DEFAULT_START_TIME,
        false,
      );
    }
    const worldRevision = this.storage.getWorldRevision() ?? stableId("world", "initial", this.stateFingerprintFor(instanceStates, this.organizationConfig));
    if (!this.storage.getWorldRevision() || this.storage.listSourceChanges().length === 0 || !this.storage.getDatasetMetadata()) {
      this.replaceWorldFromInstances(instanceStates, worldRevision, { organizationConfig: this.organizationConfig });
    }
  }

  storageKind(): StorageKind {
    return this.storage.kind;
  }

  storageHealth(): StorageHealth {
    return this.storage.health();
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

  scenarioPacks() {
    return scenarios.map(({ events, participantRoleTemplateIds, ...scenario }) => ({
      ...scenario,
      scenarioPackId: scenario.id,
      eventCount: events.length,
      participantRoleTemplateCount: participantRoleTemplateIds.length,
      sourceSystems: [...scenario.sourceSystems],
    }));
  }

  scenarioInstances() {
    return this.storage.listScenarioInstanceStates();
  }

  scenarioInstance(instanceId: string) {
    const state = this.requireInstanceState(instanceId);
    return {
      instance: instanceContextFromState(state),
      state,
      events: state.eventLog,
      changes: this.sourceChanges().filter((change) => change.scenarioInstanceId === instanceId),
    };
  }

  createScenarioInstance(input: ScenarioInstanceCreateInput) {
    const scenario = scenarios.find((candidate) => candidate.id === input.scenarioPackId);
    if (!scenario) throw badRequest(`Unknown scenario pack: ${input.scenarioPackId}`);
    const existing = this.storage.listScenarioInstanceStates();
    const state = createScenarioInstanceState(this.organization, scenario, {
      ...input,
      instanceIndex: existing.filter((candidate) => candidate.scenarioPackId === scenario.id).length,
      seed: input.seed ?? stableId("instance", this.defaultSeed, scenario.id, input.scenarioInstanceId ?? String(existing.length + 1)),
      datasetSize: input.datasetSize ?? this.defaultDatasetSize,
      startTime: input.startTime ?? DEFAULT_START_TIME,
      completed: false,
    });
    if (existing.some((candidate) => candidate.scenarioInstanceId === state.scenarioInstanceId)) {
      throw badRequest(`Scenario instance already exists: ${state.scenarioInstanceId}`);
    }
    this.commitInstanceStatesWithAppends([...existing, state], [state]);
    return this.scenarioInstance(state.scenarioInstanceId);
  }

  sourceChanges(): SourceChangeLedgerEntry[] {
    return this.storage.listSourceChanges();
  }

  sourceObjects(): SourceObjectProjection[] {
    return this.storage.listSourceObjects();
  }

  sourceObject(sourceSystem: string, sourceId: string): SourceObjectProjection {
    const object = this.sourceObjects().find((candidate) => candidate.sourceSystem === sourceSystem && candidate.sourceId === sourceId);
    if (!object) throw notFound("Unknown source object");
    return object;
  }

  sourceObjectHistory(sourceSystem: string, sourceId: string): SourceChangeLedgerEntry[] {
    const history = this.sourceChanges().filter((change) => change.sourceSystem === sourceSystem && change.sourceId === sourceId).sort(compareChanges);
    if (history.length === 0) throw notFound("Unknown source object");
    return history;
  }

  datasetMetadata(): DatasetMetadata {
    const metadata = this.storage.getDatasetMetadata();
    if (metadata) return metadata;
    return this.buildDatasetMetadata();
  }

  generateDataset(input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}): DatasetMetadata {
    const nextSeed = input.seed ?? this.defaultSeed;
    const datasetSize = input.datasetSize ?? this.defaultDatasetSize;
    const startTime = input.startTime ?? DEFAULT_START_TIME;
    const instanceStates = createDatasetInstanceStates(this.organization, nextSeed, datasetSize, startTime, true);
    this.rotateWorldRevisionFromInstances(`dataset-generate:${datasetSize}:${nextSeed}`, instanceStates);
    return this.datasetMetadata();
  }

  resetDataset(): DatasetMetadata {
    return this.generateDataset({ seed: this.defaultSeed, datasetSize: this.defaultDatasetSize, startTime: DEFAULT_START_TIME });
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

  organizationRelationships() {
    return { relationships: this.organization.reportingRelationships };
  }

  previewOrganization(config: OrganizationConfig = this.organizationConfig) {
    return { previewCounts: previewOrganizationCounts(config) };
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
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organization = nextOrganization;
    this.organizationConfig = nextConfig;
    this.connections = createConnections(this.organization);
    const nextStates = rebindInstanceParticipants(this.organization, this.storage.listScenarioInstanceStates());
    try {
      this.rotateWorldRevisionFromInstances("organization-regenerate", nextStates, { organizationConfig: nextConfig });
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
    return { organization: this.organizationSummary(), previewCounts: previewOrganizationCounts(this.organizationConfig) };
  }

  resetOrganization() {
    const nextConfig = cloneOrganizationConfig(defaultOrganizationConfig);
    const nextOrganization = buildCompatibleOrganization(nextConfig);
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organizationConfig = nextConfig;
    this.organization = nextOrganization;
    this.connections = createConnections(this.organization);
    const nextStates = rebindInstanceParticipants(this.organization, this.storage.listScenarioInstanceStates());
    try {
      this.rotateWorldRevisionFromInstances("organization-reset", nextStates, { organizationConfig: nextConfig });
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
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

  resetScenario(scenarioId: string, input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}): ScenarioInstanceState {
    return this.resetScenarioInstance(defaultInstanceId(scenarioId), input).state;
  }

  advanceScenario(scenarioId: string, input: { hours?: number; days?: number } = {}): ScenarioInstanceState {
    return this.advanceScenarioInstance(defaultInstanceId(scenarioId), input).state;
  }

  advanceScenarioInstance(instanceId: string, input: { hours?: number; days?: number } = {}) {
    const state = this.requireInstanceState(instanceId);
    if (state.paused) return this.scenarioInstance(instanceId);
    const hours = clampNumber(input.hours ?? 0, 0, 24 * 365) + clampNumber(input.days ?? 0, 0, 365) * 24;
    const current = new Date(state.currentTime);
    current.setUTCHours(current.getUTCHours() + hours);
    const nextState = finalizeInstanceState(this.organization, this.requireScenario(state.scenarioPackId), { ...state, currentTime: current.toISOString() });
    this.commitInstanceStateWithAppends(nextState);
    return this.scenarioInstance(instanceId);
  }

  triggerScenarioEvent(scenarioId: string, eventId: string): ScenarioInstanceState {
    return this.triggerScenarioInstanceEvent(defaultInstanceId(scenarioId), eventId).state;
  }

  triggerScenarioInstanceEvent(instanceId: string, eventId: string) {
    const state = this.requireInstanceState(instanceId);
    const scenario = this.requireScenario(state.scenarioPackId);
    const event = scenario.events.find((candidate) => candidate.id === eventId);
    if (!event) throw notFound(`Unknown event: ${eventId}`);
    if (state.triggeredEventIds.includes(event.id)) return this.scenarioInstance(instanceId);
    const occurredAt = state.currentTime;
    const nextState = finalizeInstanceState(this.organization, scenario, {
      ...state,
      triggeredEventIds: [...state.triggeredEventIds, event.id],
      eventOccurrenceTimes: { ...(state.eventOccurrenceTimes ?? {}), [event.id]: occurredAt },
      eventLog: [...state.eventLog, logEntry(scenario.id, state.scenarioInstanceId, event, occurredAt)],
    });
    this.commitInstanceStateWithAppends(nextState);
    return this.scenarioInstance(instanceId);
  }

  triggerScenarioEventForPack(scenarioId: string, eventId: string): ScenarioInstanceState {
    const scenario = this.requireScenario(scenarioId);
    const event = scenario.events.find((candidate) => candidate.id === eventId);
    if (!event) throw notFound(`Unknown event: ${eventId}`);
    return this.triggerScenarioEvent(scenarioId, eventId);
  }

  pauseScenario(scenarioId: string): ScenarioInstanceState {
    return this.pauseScenarioInstance(defaultInstanceId(scenarioId)).state;
  }

  pauseScenarioInstance(instanceId: string) {
    const state = { ...this.requireInstanceState(instanceId), paused: true };
    this.commitInstanceStatesWithAppends(replaceInstanceState(this.storage.listScenarioInstanceStates(), state), []);
    return this.scenarioInstance(instanceId);
  }

  resumeScenario(scenarioId: string): ScenarioInstanceState {
    return this.resumeScenarioInstance(defaultInstanceId(scenarioId)).state;
  }

  resumeScenarioInstance(instanceId: string) {
    const state = finalizeInstanceState(this.organization, this.requireScenario(this.requireInstanceState(instanceId).scenarioPackId), {
      ...this.requireInstanceState(instanceId),
      paused: false,
    });
    this.commitInstanceStateWithAppends(state);
    return this.scenarioInstance(instanceId);
  }

  resetScenarioInstance(instanceId: string, input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}) {
    const existing = this.requireInstanceState(instanceId);
    const scenario = this.requireScenario(existing.scenarioPackId);
    const resetState = createScenarioInstanceState(this.organization, scenario, {
      ...existing,
      seed: input.seed ?? existing.seed,
      datasetSize: input.datasetSize ?? existing.datasetSize,
      startTime: input.startTime ?? existing.startedAt,
      scenarioInstanceId: existing.scenarioInstanceId,
      instanceIndex: existing.instanceIndex,
      account: existing.account,
      product: existing.product,
      project: existing.project,
      service: existing.service,
      workstream: existing.workstream,
      participantPersonIds: existing.participantPersonIds,
      completed: false,
    });
    const nextStates = replaceInstanceState(this.storage.listScenarioInstanceStates(), resetState);
    this.rotateWorldRevisionFromInstances(`scenario-instance-reset:${instanceId}`, nextStates);
    return this.scenarioInstance(instanceId);
  }

  deleteScenarioInstance(instanceId: string) {
    this.requireInstanceState(instanceId);
    const nextStates = this.storage.listScenarioInstanceStates().filter((state) => state.scenarioInstanceId !== instanceId);
    this.rotateWorldRevisionFromInstances(`scenario-instance-delete:${instanceId}`, nextStates);
    return {
      deletedScenarioInstanceId: instanceId,
      remainingScenarioInstanceCount: nextStates.length,
      worldRevision: this.requireWorldRevision(),
    };
  }

  state(scenarioId: string): ScenarioInstanceState {
    return this.requireInstanceState(defaultInstanceId(scenarioId));
  }

  states(): ScenarioInstanceState[] {
    return this.storage.listScenarioInstanceStates();
  }

  eventLog(scenarioId: string) {
    return this.requireInstanceState(defaultInstanceId(scenarioId)).eventLog;
  }

  allRecords(): SourceRecord[] {
    return this.currentSourceObjects().map((object) => object.record);
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
    const worldRevision = this.requireWorldRevision();
    const cursorPayload = cursor ? decodeCursor(cursor) : { v: 3 as const, connectionId, worldRevision, afterSequence: 0 };
    if (cursorPayload.connectionId !== connectionId) {
      throw badRequest("Cursor does not belong to this connection");
    }
    if (cursorPayload.worldRevision !== worldRevision) {
      throw badRequest("Stale checkpoint: cursor world revision no longer matches the current simulator world");
    }
    const limit = Math.min(Math.max(limitInput ?? 50, 1), MAX_PAGE_SIZE);
    const visibleChanges = this.visibleLedgerEntries()
      .filter((change) => change.ledgerSequence > cursorPayload.afterSequence)
      .filter((change) => canConnectionSee(change.record, connection))
      .sort(compareChanges);
    const page = visibleChanges.slice(0, limit);
    const afterSequence = page.at(-1)?.ledgerSequence ?? cursorPayload.afterSequence;
    const batch: SourceFeedBatchV1 = {
      schemaVersion: "source-feed.v1",
      cursorVersion: 3,
      worldRevision,
      connectionId,
      batchId: stableId("batch", connectionId, cursor ?? "initial", String(limit), worldRevision, page.map((change) => change.changeId).join(",")),
      generatedAt: maxCurrentTime(this.states()),
      records: page.map((change) => change.record),
      nextCursor: encodeCursor({ v: 3, connectionId, worldRevision, afterSequence }),
      hasMore: visibleChanges.length > page.length,
    };
    return SourceFeedBatchV1Schema.parse(batch);
  }

  createSnapshot(): Snapshot {
    const snapshot: Snapshot = {
      snapshotId: stableId("snapshot", this.stateFingerprint()),
      createdAt: maxCurrentTime(this.states()),
      instanceStates: this.states(),
      organizationSeed: this.organization.seed,
      organizationConfig: this.organization.config,
      datasetMetadata: this.datasetMetadata(),
      worldRevision: this.requireWorldRevision(),
    };
    this.storage.createSnapshot(snapshot);
    return snapshot;
  }

  restoreSnapshot(snapshotId: string): Snapshot {
    const snapshot = this.storage.getSnapshot(snapshotId);
    if (!snapshot) throw notFound(`Unknown snapshot: ${snapshotId}`);
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organizationConfig = cloneOrganizationConfig(snapshot.organizationConfig);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
    try {
      this.rotateWorldRevisionFromInstances(`snapshot-restore:${snapshotId}`, snapshot.instanceStates, { organizationConfig: this.organizationConfig });
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
    return snapshot;
  }

  listSnapshots(): Snapshot[] {
    return this.storage.listSnapshots();
  }

  private requireWorldRevision(): string {
    const worldRevision = this.storage.getWorldRevision();
    if (!worldRevision) {
      throw new Error("Simulator world revision has not been initialized");
    }
    return worldRevision;
  }

  private rotateWorldRevisionFromInstances(
    reason: string,
    instanceStates: ScenarioInstanceState[],
    input: { organizationConfig?: OrganizationConfig } = {},
  ): void {
    const previous = this.storage.getWorldRevision() ?? "none";
    const worldRevision = stableId("world", reason, previous, this.stateFingerprintFor(instanceStates, input.organizationConfig ?? this.organizationConfig));
    this.replaceWorldFromInstances(instanceStates, worldRevision, input);
  }

  private replaceWorldFromInstances(
    instanceStates: ScenarioInstanceState[],
    worldRevision: string,
    input: { organizationConfig?: OrganizationConfig } = {},
  ): void {
    const changes = assignLedgerSequences(
      instanceStates.flatMap((state) => this.changesForInstanceState(state, worldRevision)),
      1,
    );
    const sourceObjects = this.projectCurrentSourceObjects(changes);
    this.storage.replaceWorld({
      scenarioInstanceStates: instanceStates,
      ...(input.organizationConfig ? { organizationConfig: input.organizationConfig } : {}),
      worldRevision,
      sourceChanges: changes,
      sourceObjects,
      datasetMetadata: this.buildDatasetMetadata(instanceStates, changes, sourceObjects, worldRevision),
    });
  }

  private commitInstanceStateWithAppends(state: ScenarioInstanceState): void {
    this.commitInstanceStatesWithAppends(replaceInstanceState(this.storage.listScenarioInstanceStates(), state), [state]);
  }

  private commitInstanceStatesWithAppends(instanceStates: ScenarioInstanceState[], changedStates: ScenarioInstanceState[]): void {
    const worldRevision = this.requireWorldRevision();
    const existingChanges = this.storage.listSourceChanges();
    const existingChangeIds = new Set(existingChanges.map((change) => change.changeId));
    const newChanges = changedStates
      .flatMap((state) => this.changesForInstanceState(state, worldRevision))
      .filter((change) => !existingChangeIds.has(change.changeId))
      .sort(compareLedgerDrafts);
    const nextSequence = (existingChanges.at(-1)?.ledgerSequence ?? 0) + 1;
    const sourceChanges = [
      ...existingChanges,
      ...assignLedgerSequences(newChanges, nextSequence),
    ].sort(compareChanges);
    const sourceObjects = this.projectCurrentSourceObjects(sourceChanges);
    this.storage.replaceWorld({
      scenarioInstanceStates: instanceStates,
      worldRevision,
      sourceChanges,
      sourceObjects,
      datasetMetadata: this.buildDatasetMetadata(instanceStates, sourceChanges, sourceObjects, worldRevision),
    });
  }

  private visibleLedgerEntries(): SourceChangeLedgerEntry[] {
    return this.storage.listSourceChanges().sort(compareChanges);
  }

  private currentSourceObjects(): SourceObjectProjection[] {
    return this.projectCurrentSourceObjects(this.visibleLedgerEntries());
  }

  private projectCurrentSourceObjects(changes: SourceChangeLedgerEntry[]): SourceObjectProjection[] {
    const bySource = new Map<string, SourceChangeLedgerEntry>();
    for (const change of changes.sort(compareChanges)) {
      bySource.set(sourceKey(change.sourceSystem, change.sourceId), change);
    }
    return [...bySource.values()].map((change) => ({
      sourceKey: sourceKey(change.sourceSystem, change.sourceId),
      worldRevision: change.worldRevision,
      sourceSystem: change.sourceSystem,
      sourceId: change.sourceId,
      currentChangeId: change.changeId,
      currentChangeType: change.changeType,
      record: change.record,
    }));
  }

  private changesForInstanceState(state: ScenarioInstanceState, worldRevision: string): SourceChangeLedgerEntry[] {
    const scenario = this.requireScenario(state.scenarioPackId);
    return scenario.events.flatMap((event) => {
      if (!hasEventOccurred(state, event)) return [];
      return event.records.flatMap((template) => {
        const records = [materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, state, "created")];
        if (template.updatedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, state, "updated"));
        }
        if (template.deletedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, state, "deleted"));
        }
        return records
          .filter((record) => Date.parse(record.changeOccurredAt) <= Date.parse(state.currentTime))
          .map((record) => ledgerEntry(worldRevision, scenario, event, state, template, record));
      });
    });
  }

  private buildDatasetMetadata(
    instanceStates: ScenarioInstanceState[] = this.states(),
    changes: SourceChangeLedgerEntry[] = this.storage.listSourceChanges(),
    objects: SourceObjectProjection[] = this.storage.listSourceObjects(),
    worldRevision: string = this.requireWorldRevision(),
  ): DatasetMetadata {
    const firstState = instanceStates[0];
    const countsBySourceSystem = Object.fromEntries(sourceSystems.map((source) => [source, 0])) as DatasetMetadata["countsBySourceSystem"];
    for (const change of changes) countsBySourceSystem[change.sourceSystem] += 1;
    return {
      schemaVersion: "dataset-metadata.v1",
      datasetId: stableId("dataset", this.stateFingerprintFor(instanceStates, this.organizationConfig), String(changes.length)),
      seed: firstState?.seed ?? this.defaultSeed,
      datasetSize: firstState?.datasetSize ?? this.defaultDatasetSize,
      generatedAt: maxCurrentTime(instanceStates),
      scenarioPackCount: scenarios.length,
      scenarioInstanceCount: instanceStates.length,
      totalSourceChanges: changes.length,
      totalSourceObjects: objects.length,
      countsBySourceSystem,
      worldRevision,
    };
  }

  private requireScenario(scenarioId: string): ScenarioDefinition {
    const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario) throw notFound(`Unknown scenario: ${scenarioId}`);
    return scenario;
  }

  private requireInstanceState(instanceId: string): ScenarioInstanceState {
    const state = this.storage.getScenarioInstanceState(instanceId);
    if (!state) throw notFound(`Unknown scenario instance: ${instanceId}`);
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
    return this.stateFingerprintFor(this.states(), this.organization.config);
  }

  private stateFingerprintFor(instanceStates: ScenarioInstanceState[], organizationConfig: OrganizationConfig): string {
    return stableId("state", JSON.stringify(instanceStates), JSON.stringify(organizationConfig));
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

function createDatasetInstanceStates(
  organization: GeneratedOrganization,
  seed: string,
  datasetSize: DatasetSize,
  startTime: string,
  completed: boolean,
): ScenarioInstanceState[] {
  return scenarios.flatMap((scenario) => {
    const count = INSTANCE_COUNTS[datasetSize];
    const span = INSTANCE_SPANS_HOURS[datasetSize];
    return Array.from({ length: count }, (_, index) => {
      const offsetHours = count <= 1 ? 0 : Math.floor((span * index) / count);
      const startedAt = addHours(startTime, offsetHours);
      const account = INSTANCE_ACCOUNTS[hashNumber(seed, scenario.id, String(index), "account") % INSTANCE_ACCOUNTS.length]!;
      const product = INSTANCE_PRODUCTS[hashNumber(seed, scenario.id, String(index), "product") % INSTANCE_PRODUCTS.length]!;
      const project = INSTANCE_PROJECTS[hashNumber(seed, scenario.id, String(index), "project") % INSTANCE_PROJECTS.length]!;
      const service = INSTANCE_SERVICES[hashNumber(seed, scenario.id, String(index), "service") % INSTANCE_SERVICES.length]!;
      const suffix = index === 0 ? "default" : `${slug(account)}-${String(index + 1).padStart(2, "0")}`;
      return createScenarioInstanceState(organization, scenario, {
        scenarioPackId: scenario.id,
        scenarioInstanceId: `${scenario.id}-${suffix}`,
        instanceIndex: index,
        seed: stableId("instance", seed, scenario.id, String(index)),
        datasetSize,
        startTime: startedAt,
        account,
        product,
        project,
        service,
        workstream: `${slug(project)}-${slug(service)}`,
        completed,
      });
    });
  });
}

function createScenarioInstanceState(
  organization: GeneratedOrganization,
  scenario: ScenarioDefinition,
  input: ScenarioInstanceCreateInput & { instanceIndex: number; completed?: boolean },
): ScenarioInstanceState {
  const seed = input.seed ?? stableId("instance", scenario.id, input.scenarioInstanceId ?? String(input.instanceIndex));
  const startedAt = new Date(input.startTime ?? DEFAULT_START_TIME).toISOString();
  const currentTime = input.completed ? addHours(startedAt, DATASET_DURATION_HOURS[input.datasetSize ?? "small"]) : startedAt;
  const account = input.account ?? INSTANCE_ACCOUNTS[hashNumber(seed, "account") % INSTANCE_ACCOUNTS.length]!;
  const product = input.product ?? INSTANCE_PRODUCTS[hashNumber(seed, "product") % INSTANCE_PRODUCTS.length]!;
  const project = input.project ?? INSTANCE_PROJECTS[hashNumber(seed, "project") % INSTANCE_PROJECTS.length]!;
  const service = input.service ?? INSTANCE_SERVICES[hashNumber(seed, "service") % INSTANCE_SERVICES.length]!;
  const scenarioInstanceId = input.scenarioInstanceId ?? `${scenario.id}-${slug(account)}-${shortHash(seed).slice(0, 6)}`;
  const baseState: ScenarioInstanceState = {
    scenarioPackId: scenario.id,
    scenarioInstanceId,
    instanceIndex: input.instanceIndex,
    label: `${scenario.title} - ${account}`,
    seed,
    datasetSize: input.datasetSize ?? "small",
    startedAt,
    currentTime,
    paused: false,
    triggeredEventIds: input.completed ? scenario.events.map((event) => event.id) : [],
    eventOccurrenceTimes: {},
    eventLog: [],
    completionState: "active",
    account,
    product,
    project,
    service,
    workstream: input.workstream ?? `${slug(project)}-${slug(service)}`,
    timeOffsetHours: 0,
    participantPersonIds: {
      ...resolveParticipants(organization, scenario, seed),
      ...(input.participantPersonIds ?? {}),
    },
  };
  return finalizeInstanceState(organization, scenario, baseState);
}

function finalizeInstanceState(
  organization: GeneratedOrganization,
  scenario: ScenarioDefinition,
  state: ScenarioInstanceState,
): ScenarioInstanceState {
  validateParticipantOverrides(organization, state.participantPersonIds);
  const eventIds = new Set(state.triggeredEventIds);
  const eventOccurrenceTimes: Record<string, string> = {};
  for (const entry of state.eventLog) eventOccurrenceTimes[entry.eventId] = entry.occurredAt;
  Object.assign(eventOccurrenceTimes, state.eventOccurrenceTimes ?? {});
  for (const event of scenario.events) {
    const scheduledAt = addHours(state.startedAt, event.atHour);
    if (!event.manual && Date.parse(scheduledAt) <= Date.parse(state.currentTime)) {
      eventIds.add(event.id);
    }
    if (eventIds.has(event.id) && !eventOccurrenceTimes[event.id]) {
      eventOccurrenceTimes[event.id] = scheduledAt;
    }
  }
  const allEventsOccurred = scenario.events.every((event) => eventIds.has(event.id));
  const eventLog = scenario.events
    .filter((event) => eventIds.has(event.id))
    .map((event) => logEntry(scenario.id, state.scenarioInstanceId, event, eventOccurrenceTimes[event.id] ?? addHours(state.startedAt, event.atHour)));
  return {
    ...state,
    triggeredEventIds: [...eventIds],
    eventOccurrenceTimes,
    eventLog: eventLog.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.eventId.localeCompare(right.eventId)),
    completionState: allEventsOccurred ? "completed" : "active",
  };
}

function rebindInstanceParticipants(organization: GeneratedOrganization, states: ScenarioInstanceState[]): ScenarioInstanceState[] {
  const people = new Map(organization.people.map((person) => [person.id, person]));
  return states.map((state) => {
    const scenario = scenarios.find((candidate) => candidate.id === state.scenarioPackId);
    if (!scenario) return state;
    const defaults = resolveParticipants(organization, scenario, state.seed);
    const participantPersonIds = { ...defaults };
    for (const [roleTemplateId, personId] of Object.entries(state.participantPersonIds)) {
      const person = people.get(personId);
      participantPersonIds[roleTemplateId] = person?.roleTemplateId === roleTemplateId ? personId : defaults[roleTemplateId]!;
    }
    return finalizeInstanceState(organization, scenario, { ...state, participantPersonIds });
  });
}

function materializeRecord(
  baseUrl: string,
  state: ScenarioInstanceState,
  scenario: ScenarioDefinition,
  event: ScenarioEventTemplate,
  template: ScenarioRecordTemplate,
  organization: GeneratedOrganization,
  instance: ScenarioInstanceContext,
  changeType: SourceChangeType,
): SourceRecord {
  const occurredAt = eventOccurredAt(state, event);
  const sourceId = stableId(template.sourceSystem, state.seed, organization.seed, scenario.id, instance.scenarioInstanceId, event.id, template.id);
  const visibleAt = template.visibleAfterHours === undefined ? occurredAt : addHours(occurredAt, template.visibleAfterHours);
  const mutationAt = template.updatedAfterHours === undefined ? undefined : addHours(occurredAt, template.updatedAfterHours);
  const deletionAt = template.deletedAfterHours === undefined ? undefined : addHours(occurredAt, template.deletedAfterHours);
  const isUpdatedChange = changeType === "updated";
  const isDeletedChange = changeType === "deleted";
  const changeOccurredAt = isDeletedChange && deletionAt ? deletionAt : isUpdatedChange && mutationAt ? mutationAt : visibleAt;
  const actor = selectInstancePersonForRole(organization, state, template.actorRoleTemplateId, `${scenario.id}:${instance.scenarioInstanceId}:${event.id}:${template.id}:actor`);
  const assignee = template.assignmentRoleTemplateId
    ? selectInstancePersonForRole(organization, state, template.assignmentRoleTemplateId, `${scenario.id}:${instance.scenarioInstanceId}:${event.id}:${template.id}:assignee`)
    : null;
  const managerChain = managementChain(organization, assignee ?? actor);
  const adapter = requireSourceAdapter(template.sourceSystem);
  const adapterInput = {
    baseUrl,
    sourceId,
    occurredAt,
    changeOccurredAt,
    changeType,
    scenario,
    event,
    template,
    state,
    instance,
    organization,
    actor,
    assignee,
    managerChain,
  };
  const draft = changeType === "deleted" ? adapter.remove(adapterInput) : changeType === "updated" ? adapter.update(adapterInput) : adapter.create(adapterInput);
  const validation = adapter.validatePayload(draft.rawPayload);
  if (!validation.ok) throw new Error(`Invalid ${template.sourceSystem} payload for ${template.id}: ${validation.errors.join("; ")}`);
  const rawPayload: Record<string, unknown> = {
    ...draft.rawPayload,
    simulatorSourceId: sourceId,
    simulatorScenarioPackId: scenario.id,
    simulatorScenarioInstanceId: instance.scenarioInstanceId,
    scenarioTime: occurredAt,
    actorPersonId: actor.id,
    actorEmail: actor.email,
    assigneePersonId: assignee?.id ?? null,
    assigneeEmail: assignee?.email ?? null,
    simulatorVersion: isDeletedChange ? "deleted" : isUpdatedChange ? "updated" : "initial",
  };
  if (isUpdatedChange && mutationAt) rawPayload.simulatorUpdatedAt = mutationAt;
  if (isDeletedChange && deletionAt) rawPayload.simulatorDeletedAt = deletionAt;
  if (isDeletedChange) rawPayload.tombstone = true;

  const record: SourceRecord = {
    schemaVersion: "source-record.v1",
    sourceSystem: template.sourceSystem,
    sourceId,
    objectType: template.objectType,
    occurredAt,
    title: template.title,
    sourceUrl: draft.sourceUrl,
    actorRef: actor.id,
    acl: template.acl,
    rawPayload,
    changeId: stableId("change", sourceId, changeType),
    changeType,
    changeSequence: 1,
    changeOccurredAt,
    correlation: {
      scenarioId: scenario.id,
      eventId: event.id,
      templateId: template.id,
      seedFingerprint: stableId("seed", state.seed, organization.seed),
    },
  };
  if (isUpdatedChange && mutationAt) record.updatedAt = mutationAt;
  if (isDeletedChange && deletionAt) record.updatedAt = deletionAt;
  return record;
}

function ledgerEntry(
  worldRevision: string,
  scenario: ScenarioDefinition,
  event: ScenarioEventTemplate,
  instance: ScenarioInstanceContext,
  template: ScenarioRecordTemplate,
  record: SourceRecord,
): SourceChangeLedgerEntry {
  return {
    ledgerSequence: 0,
    worldRevision,
    changeId: record.changeId,
    changeType: record.changeType,
    sourceSystem: record.sourceSystem,
    sourceId: record.sourceId,
    changeOccurredAt: record.changeOccurredAt,
    sourceOccurredAt: record.occurredAt,
    scenarioId: scenario.id,
    scenarioPackId: scenario.id,
    scenarioInstanceId: instance.scenarioInstanceId,
    businessEventId: event.id,
    templateId: template.id,
    record,
    permissionScope: record.acl,
  };
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

function sourceKey(sourceSystem: string, sourceId: string): string {
  return `${sourceSystem}:${sourceId}`;
}

function compareLedgerDrafts(left: SourceChangeLedgerEntry, right: SourceChangeLedgerEntry): number {
  return (
    Date.parse(left.changeOccurredAt) - Date.parse(right.changeOccurredAt) ||
    Date.parse(left.sourceOccurredAt) - Date.parse(right.sourceOccurredAt) ||
    left.scenarioPackId.localeCompare(right.scenarioPackId) ||
    left.scenarioInstanceId.localeCompare(right.scenarioInstanceId) ||
    left.businessEventId.localeCompare(right.businessEventId) ||
    left.templateId.localeCompare(right.templateId) ||
    left.changeType.localeCompare(right.changeType) ||
    left.changeId.localeCompare(right.changeId)
  );
}

function compareChanges(left: SourceChangeLedgerEntry, right: SourceChangeLedgerEntry): number {
  return left.ledgerSequence - right.ledgerSequence || left.changeId.localeCompare(right.changeId);
}

function assignLedgerSequences(changes: SourceChangeLedgerEntry[], firstSequence: number): SourceChangeLedgerEntry[] {
  return changes.sort(compareLedgerDrafts).map((change, index) => ({
    ...change,
    ledgerSequence: firstSequence + index,
    record: { ...change.record, changeSequence: firstSequence + index },
  }));
}

function addHours(start: string, hours: number): string {
  const date = new Date(start);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function maxCurrentTime(states: ScenarioInstanceState[]): string {
  return states.map((state) => state.currentTime).sort().at(-1) ?? new Date(DEFAULT_START_TIME).toISOString();
}

function logEntry(scenarioId: string, scenarioInstanceId: string, event: ScenarioEventTemplate, occurredAt: string) {
  return {
    scenarioId,
    scenarioInstanceId,
    eventId: event.id,
    label: event.label,
    occurredAt,
    recordTemplateIds: event.records.map((record) => record.id),
  };
}

function defaultInstanceId(scenarioId: string): string {
  return `${scenarioId}-default`;
}

function instanceContextFromState(state: ScenarioInstanceState): ScenarioInstanceContext {
  const {
    scenarioPackId,
    scenarioInstanceId,
    instanceIndex,
    label,
    seed,
    account,
    product,
    project,
    service,
    workstream,
    timeOffsetHours,
  } = state;
  return { scenarioPackId, scenarioInstanceId, instanceIndex, label, seed, account, product, project, service, workstream, timeOffsetHours };
}

function replaceInstanceState(states: ScenarioInstanceState[], replacement: ScenarioInstanceState): ScenarioInstanceState[] {
  let replaced = false;
  const next = states.map((state) => {
    if (state.scenarioInstanceId !== replacement.scenarioInstanceId) return state;
    replaced = true;
    return replacement;
  });
  return replaced ? next : [...next, replacement];
}

function hasEventOccurred(state: ScenarioInstanceState, event: ScenarioEventTemplate): boolean {
  return state.triggeredEventIds.includes(event.id);
}

function eventOccurredAt(state: ScenarioInstanceState, event: ScenarioEventTemplate): string {
  return state.eventOccurrenceTimes?.[event.id] ?? state.eventLog.find((entry) => entry.eventId === event.id)?.occurredAt ?? addHours(state.startedAt, event.atHour);
}

function resolveParticipants(organization: GeneratedOrganization, scenario: ScenarioDefinition, seed: string): Record<string, string> {
  const roleTemplateIds = new Set(scenario.participantRoleTemplateIds);
  for (const event of scenario.events) {
    for (const record of event.records) {
      roleTemplateIds.add(record.actorRoleTemplateId);
      if (record.assignmentRoleTemplateId) roleTemplateIds.add(record.assignmentRoleTemplateId);
    }
  }
  return Object.fromEntries(
    [...roleTemplateIds].map((roleTemplateId) => [
      roleTemplateId,
      selectPersonForRole(organization, roleTemplateId, `${scenario.id}:${seed}:${roleTemplateId}`).id,
    ]),
  );
}

function validateParticipantOverrides(organization: GeneratedOrganization, participantPersonIds: Record<string, string>): void {
  const people = new Map(organization.people.map((person) => [person.id, person]));
  for (const [roleTemplateId, personId] of Object.entries(participantPersonIds)) {
    const person = people.get(personId);
    if (!person) throw badRequest(`Unknown participant person ${personId} for ${roleTemplateId}`);
    if (person.roleTemplateId !== roleTemplateId) {
      throw badRequest(`Participant ${personId} does not match role template ${roleTemplateId}`);
    }
  }
}

function selectInstancePersonForRole(organization: GeneratedOrganization, state: ScenarioInstanceState, roleTemplateId: string, fallbackKey: string): Person {
  const participantId = state.participantPersonIds[roleTemplateId];
  const participant = participantId ? organization.people.find((person) => person.id === participantId) : undefined;
  return participant ?? selectPersonForRole(organization, roleTemplateId, fallbackKey);
}

function managementChain(organization: GeneratedOrganization, person: Person): Person[] {
  const peopleById = new Map(organization.people.map((candidate) => [candidate.id, candidate]));
  const chain: Person[] = [];
  let managerId = person.managerId;
  while (managerId) {
    const manager = peopleById.get(managerId);
    if (!manager) break;
    chain.push(manager);
    managerId = manager.managerId;
  }
  return chain;
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function hashNumber(...parts: string[]): number {
  return Number.parseInt(createHash("sha256").update(parts.join("|"), "utf8").digest("hex").slice(0, 8), 16);
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
