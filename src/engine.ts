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
  type ScenarioRecordTemplate,
  type ScenarioState,
  type Snapshot,
  type SourceChangeLedgerEntry,
  type SourceChangeType,
  type SourceConnection,
  type SourceObjectProjection,
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
const INSTANCE_ACCOUNTS = ["Northstar Medical", "Summit Foods", "Cobalt Bank", "Beacon Retail", "Atlas Logistics", "Pioneer Health"];
const INSTANCE_PRODUCTS = ["Workflow Hub", "Operations Control", "Connector Gateway", "Analytics Studio", "Customer Console", "Identity Fabric"];
const INSTANCE_PROJECTS = ["Aurora", "Beacon", "Comet", "Delta", "Evergreen", "Foundry"];
const INSTANCE_SERVICES = ["ingestion", "workflow-export", "identity", "analytics", "notifications", "audit-stream"];

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
    this.ensureWorldRevision();
    this.rebuildLedger();
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
    return scenarios.flatMap((scenario) => this.instanceContextsForScenario(scenario).map((instance) => ({ ...instance, scenarioPackId: scenario.id })));
  }

  scenarioInstance(instanceId: string) {
    const instance = this.scenarioInstances().find((candidate) => candidate.scenarioInstanceId === instanceId);
    if (!instance) throw notFound(`Unknown scenario instance: ${instanceId}`);
    return {
      instance,
      state: this.requireState(instance.scenarioPackId),
      events: this.eventLog(instance.scenarioPackId),
      changes: this.sourceChanges().filter((change) => change.scenarioInstanceId === instanceId),
    };
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
    this.storage.replaceScenarioStates(scenarios.map((scenario) => createInitialState(scenario.id, nextSeed, datasetSize, startTime)));
    this.rotateWorldRevision(`dataset-generate:${datasetSize}:${nextSeed}`);
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
    this.organizationConfig = nextConfig;
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.organization = nextOrganization;
    this.connections = createConnections(this.organization);
    this.rotateWorldRevision("organization-regenerate");
    return { organization: this.organizationSummary(), previewCounts: previewOrganizationCounts(this.organizationConfig) };
  }

  resetOrganization() {
    this.organizationConfig = cloneOrganizationConfig(defaultOrganizationConfig);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.storage.saveOrganizationConfig(this.organizationConfig);
    this.connections = createConnections(this.organization);
    this.rotateWorldRevision("organization-reset");
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
    this.rotateWorldRevision(`scenario-reset:${scenarioId}`);
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
    this.refreshSourceObjects();
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
      this.refreshSourceObjects();
      return nextState;
    }
    return state;
  }

  pauseScenario(scenarioId: string): ScenarioState {
    const state = { ...this.requireState(scenarioId), paused: true };
    this.storage.saveScenarioState(state);
    this.refreshSourceObjects();
    return state;
  }

  resumeScenario(scenarioId: string): ScenarioState {
    const state = { ...this.requireState(scenarioId), paused: false };
    this.storage.saveScenarioState(state);
    this.refreshSourceObjects();
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
      states: this.states(),
      organizationSeed: this.organization.seed,
      organizationConfig: this.organization.config,
      datasetMetadata: this.datasetMetadata(),
      worldRevision: this.requireWorldRevision(),
      sourceChanges: this.storage.listSourceChanges(),
      sourceObjects: this.storage.listSourceObjects(),
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
    this.rotateWorldRevision(`snapshot-restore:${snapshotId}`);
    return snapshot;
  }

  listSnapshots(): Snapshot[] {
    return this.storage.listSnapshots();
  }

  private ensureWorldRevision(): void {
    if (!this.storage.getWorldRevision()) {
      this.storage.saveWorldRevision(stableId("world", "initial", this.stateFingerprint()));
    }
  }

  private requireWorldRevision(): string {
    const worldRevision = this.storage.getWorldRevision();
    if (!worldRevision) {
      throw new Error("Simulator world revision has not been initialized");
    }
    return worldRevision;
  }

  private rotateWorldRevision(reason: string): void {
    const previous = this.storage.getWorldRevision() ?? "none";
    this.storage.saveWorldRevision(stableId("world", reason, previous, this.stateFingerprint()));
    this.rebuildLedger();
  }

  private rebuildLedger(): void {
    const worldRevision = this.requireWorldRevision();
    const changes = scenarios
      .flatMap((scenario) => this.changesForScenario(scenario, worldRevision))
      .sort(compareLedgerDrafts)
      .map((change, index) => ({
        ...change,
        ledgerSequence: index + 1,
        record: { ...change.record, changeSequence: index + 1 },
      }));
    this.storage.replaceSourceChanges(changes);
    this.refreshSourceObjects();
  }

  private refreshSourceObjects(): void {
    this.storage.replaceSourceObjects(this.projectCurrentSourceObjects(this.visibleLedgerEntries()));
    this.storage.saveDatasetMetadata(this.buildDatasetMetadata());
  }

  private visibleLedgerEntries(): SourceChangeLedgerEntry[] {
    return this.storage
      .listSourceChanges()
      .filter((change) => this.isChangeVisible(change))
      .sort(compareChanges);
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

  private isChangeVisible(change: SourceChangeLedgerEntry): boolean {
    const scenario = this.requireScenario(change.scenarioId);
    const event = scenario.events.find((candidate) => candidate.id === change.businessEventId);
    if (!event) return false;
    const state = this.requireState(change.scenarioId);
    const eventVisible = Date.parse(change.sourceOccurredAt) <= Date.parse(state.currentTime) || state.triggeredEventIds.includes(event.id);
    return eventVisible && Date.parse(change.changeOccurredAt) <= Date.parse(state.currentTime);
  }

  private changesForScenario(scenario: ScenarioDefinition, worldRevision: string): SourceChangeLedgerEntry[] {
    const state = this.requireState(scenario.id);
    return this.instanceContextsForScenario(scenario).flatMap((instance) =>
      scenario.events.flatMap((event) =>
        event.records.flatMap((template) => {
        const records = [materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, instance, "created")];
        if (template.updatedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, instance, "updated"));
        }
        if (template.deletedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, this.organization, instance, "deleted"));
        }
          return records.map((record) => ledgerEntry(worldRevision, scenario, event, instance, template, record));
        }),
      ),
    );
  }

  private instanceContextsForScenario(scenario: ScenarioDefinition): ScenarioInstanceContext[] {
    const state = this.requireState(scenario.id);
    const count = INSTANCE_COUNTS[state.datasetSize];
    const span = INSTANCE_SPANS_HOURS[state.datasetSize];
    return Array.from({ length: count }, (_, index) => {
      const account = INSTANCE_ACCOUNTS[hashNumber(state.seed, scenario.id, String(index), "account") % INSTANCE_ACCOUNTS.length]!;
      const product = INSTANCE_PRODUCTS[hashNumber(state.seed, scenario.id, String(index), "product") % INSTANCE_PRODUCTS.length]!;
      const project = INSTANCE_PROJECTS[hashNumber(state.seed, scenario.id, String(index), "project") % INSTANCE_PROJECTS.length]!;
      const service = INSTANCE_SERVICES[hashNumber(state.seed, scenario.id, String(index), "service") % INSTANCE_SERVICES.length]!;
      const suffix = index === 0 ? "default" : `${slug(account)}-${String(index + 1).padStart(2, "0")}`;
      return {
        scenarioPackId: scenario.id,
        scenarioInstanceId: `${scenario.id}-${suffix}`,
        instanceIndex: index,
        label: `${scenario.title} - ${account}`,
        seed: stableId("instance", state.seed, scenario.id, String(index)),
        account,
        product,
        project,
        service,
        workstream: `${slug(project)}-${slug(service)}`,
        timeOffsetHours: count <= 1 ? 0 : Math.floor((span * index) / count),
      };
    });
  }

  private buildDatasetMetadata(): DatasetMetadata {
    const changes = this.storage.listSourceChanges();
    const objects = this.storage.listSourceObjects();
    const firstState = this.states()[0];
    const countsBySourceSystem = Object.fromEntries(sourceSystems.map((source) => [source, 0])) as DatasetMetadata["countsBySourceSystem"];
    for (const change of changes) countsBySourceSystem[change.sourceSystem] += 1;
    return {
      schemaVersion: "dataset-metadata.v1",
      datasetId: stableId("dataset", this.stateFingerprint(), String(changes.length)),
      seed: firstState?.seed ?? this.defaultSeed,
      datasetSize: firstState?.datasetSize ?? this.defaultDatasetSize,
      generatedAt: maxCurrentTime(this.states()),
      scenarioPackCount: scenarios.length,
      scenarioInstanceCount: this.scenarioInstances().length,
      totalSourceChanges: changes.length,
      totalSourceObjects: objects.length,
      countsBySourceSystem,
      worldRevision: this.requireWorldRevision(),
    };
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
  instance: ScenarioInstanceContext,
  changeType: SourceChangeType,
): SourceRecord {
  const occurredAt = addHours(state.startedAt, event.atHour + instance.timeOffsetHours);
  const sourceId = stableId(template.sourceSystem, state.seed, organization.seed, scenario.id, instance.scenarioInstanceId, event.id, template.id);
  const visibleAt = template.visibleAfterHours === undefined ? occurredAt : addHours(occurredAt, template.visibleAfterHours);
  const mutationAt = template.updatedAfterHours === undefined ? undefined : addHours(occurredAt, template.updatedAfterHours);
  const deletionAt = template.deletedAfterHours === undefined ? undefined : addHours(occurredAt, template.deletedAfterHours);
  const isUpdatedChange = changeType === "updated";
  const isDeletedChange = changeType === "deleted";
  const changeOccurredAt = isDeletedChange && deletionAt ? deletionAt : isUpdatedChange && mutationAt ? mutationAt : visibleAt;
  const actor = selectPersonForRole(organization, template.actorRoleTemplateId, `${scenario.id}:${instance.scenarioInstanceId}:${event.id}:${template.id}:actor`);
  const assignee = template.assignmentRoleTemplateId
    ? selectPersonForRole(organization, template.assignmentRoleTemplateId, `${scenario.id}:${instance.scenarioInstanceId}:${event.id}:${template.id}:assignee`)
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
