import { createHash } from "node:crypto";
import { z } from "zod";
import { requireSourceAdapter } from "./adapters/registry.js";
import { SourceFeedBatchV1Schema, type SourceFeedBatchV1 } from "./contracts.js";
import { scenarios, tenant } from "./data.js";
import {
  type ContinuousOrchestrationState,
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
  type SimulationClockMode,
  type SimulationClockState,
  type SimulationReconciliationReport,
  type Snapshot,
  type SourceChangeLedgerEntry,
  type SourceChangeType,
  type SourceConnection,
  type SourceObjectProjection,
  type SourceRecord,
  type Team,
} from "./domain.js";
import {
  MemorySimulatorStorage,
  type SimulatorStorage,
  type StorageHealth,
  type StorageKind,
  type WorldReplacement,
  type WorldSnapshot,
} from "./storage.js";
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
  clockMode?: SimulationClockMode;
  clockSpeedMultiplier?: number;
  continuousActivity?: boolean;
  maxCatchUpSeconds?: number;
  maxSuccessorInstancesPerReconciliation?: number;
  minSuccessorIntervalHours?: number;
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
const DEFAULT_CLOCK_SPEED_MULTIPLIER = 30;
const DEFAULT_MAX_CATCH_UP_SECONDS = 60 * 60 * 6;
const DEFAULT_MAX_SUCCESSORS_PER_RECONCILIATION = 6;
const DEFAULT_MIN_SUCCESSOR_INTERVAL_HOURS = 12;
const MAX_CLOCK_SPEED_MULTIPLIER = 24 * 60;
const ACTIVITY_PROFILE_DEFAULTS: Record<ContinuousOrchestrationState["activityProfile"], { maxSuccessorInstancesPerReconciliation: number; minSuccessorIntervalHours: number }> = {
  quiet: { maxSuccessorInstancesPerReconciliation: 2, minSuccessorIntervalHours: 24 },
  standard: { maxSuccessorInstancesPerReconciliation: DEFAULT_MAX_SUCCESSORS_PER_RECONCILIATION, minSuccessorIntervalHours: DEFAULT_MIN_SUCCESSOR_INTERVAL_HOURS },
  intense: { maxSuccessorInstancesPerReconciliation: 20, minSuccessorIntervalHours: 4 },
};
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

export interface ClockUpdateInput {
  mode?: SimulationClockMode;
  speedMultiplier?: number;
  paused?: boolean;
  continuousActivity?: boolean;
  maxCatchUpSeconds?: number;
  activityProfile?: ContinuousOrchestrationState["activityProfile"];
  maxSuccessorInstancesPerReconciliation?: number;
  minSuccessorIntervalHours?: number;
}

export interface ReconcileSimulationClockInput {
  now?: string;
  trigger?: SimulationReconciliationReport["trigger"];
}

export class SourceSimulator {
  private readonly storage: SimulatorStorage;
  private readonly defaultSeed: string;
  private readonly defaultDatasetSize: DatasetSize;
  private readonly baseUrl: string;
  private organizationConfig: OrganizationConfig;
  private organization: GeneratedOrganization;
  private connections: SourceConnection[];
  private knownWorldRevision: string | undefined;

  constructor(options: SimulatorOptions = {}) {
    this.storage = options.storage ?? new MemorySimulatorStorage();
    this.defaultSeed = options.seed ?? "wfo-m1-seed";
    this.defaultDatasetSize = options.datasetSize ?? "small";
    this.baseUrl = options.baseUrl ?? "http://localhost:3000";
    this.organizationConfig = cloneOrganizationConfig(options.organizationConfig ?? { ...defaultOrganizationConfig, seed: options.seed ?? defaultOrganizationConfig.seed });
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
  }

  static async create(options: SimulatorOptions = {}): Promise<SourceSimulator> {
    const simulator = new SourceSimulator(options);
    await simulator.initialize(options);
    return simulator;
  }

  private async initialize(options: SimulatorOptions): Promise<void> {
    const storedOrganizationConfig = await this.storage.getOrganizationConfig();
    this.organizationConfig = cloneOrganizationConfig(
      options.organizationConfig ?? storedOrganizationConfig ?? { ...defaultOrganizationConfig, seed: options.seed ?? defaultOrganizationConfig.seed },
    );
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    await this.storage.saveOrganizationConfig(this.organizationConfig);
    this.connections = createConnections(this.organization);

    let instanceStates = await this.storage.listScenarioInstanceStates();
    if (instanceStates.length === 0) {
      instanceStates = createDatasetInstanceStates(
        this.organization,
        this.defaultSeed,
        this.defaultDatasetSize,
        options.now ?? DEFAULT_START_TIME,
        false,
      );
    }
    const initialClock = buildDefaultClockState(options.now ?? DEFAULT_START_TIME, {
      mode: options.clockMode ?? "manual",
      speedMultiplier: options.clockSpeedMultiplier ?? DEFAULT_CLOCK_SPEED_MULTIPLIER,
      continuousActivity: options.continuousActivity ?? false,
      maxCatchUpSeconds: options.maxCatchUpSeconds ?? DEFAULT_MAX_CATCH_UP_SECONDS,
    });
    const initialOrchestration = buildDefaultOrchestrationState(options.now ?? DEFAULT_START_TIME, {
      enabled: options.continuousActivity ?? false,
      maxSuccessorInstancesPerReconciliation: options.maxSuccessorInstancesPerReconciliation ?? DEFAULT_MAX_SUCCESSORS_PER_RECONCILIATION,
      minSuccessorIntervalHours: options.minSuccessorIntervalHours ?? DEFAULT_MIN_SUCCESSOR_INTERVAL_HOURS,
    });
    const storedClock = await this.storage.getClockState();
    const storedOrchestration = await this.storage.getOrchestrationState();
    const storedWorldRevision = await this.storage.getWorldRevision();
    const worldRevision = storedWorldRevision ?? stableId("world", "initial", this.stateFingerprintFor(instanceStates, this.organizationConfig));
    if (!storedWorldRevision || (await this.storage.listSourceChanges()).length === 0 || !(await this.storage.getDatasetMetadata())) {
      await this.replaceWorldFromInstances(instanceStates, worldRevision, {
        organizationConfig: this.organizationConfig,
        clockState: storedClock ?? initialClock,
        orchestrationState: storedOrchestration ?? initialOrchestration,
      });
    } else {
      if (!storedClock) await this.storage.saveClockState(initialClock);
      if (!storedOrchestration) await this.storage.saveOrchestrationState(initialOrchestration);
    }
    this.knownWorldRevision = await this.storage.getWorldRevision();
  }

  storageKind(): StorageKind {
    return this.storage.kind;
  }

  async close(): Promise<void> {
    await this.storage.close?.();
  }

  async storageHealth(): Promise<StorageHealth> {
    return this.storage.health();
  }

  async refreshOrganizationFromStorage(): Promise<void> {
    const storedOrganizationConfig = await this.storage.getOrganizationConfig();
    if (!storedOrganizationConfig) return;
    if (JSON.stringify(storedOrganizationConfig) === JSON.stringify(this.organizationConfig)) return;
    this.organizationConfig = cloneOrganizationConfig(storedOrganizationConfig);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
  }

  async clockStatus() {
    const clock = await this.requireClockState();
    const orchestration = await this.requireOrchestrationState(clock);
    const states = await this.states();
    return {
      schemaVersion: "simulation-clock-status.v1",
      clock,
      orchestration,
      scenarioInstances: {
        active: states.filter((state) => state.completionState === "active").length,
        completed: states.filter((state) => state.completionState === "completed").length,
        total: states.length,
      },
      recentSuccessorInstances: orchestration.recentSuccessorInstanceIds,
      recentSourceChanges: (await this.sourceChanges()).slice(-10),
    };
  }

  async updateClock(input: ClockUpdateInput, now = new Date().toISOString()): Promise<SimulationClockState> {
    validateClockUpdate(input);
    const normalizedNow = new Date(now).toISOString();
    const output = await this.storage.mutateWorld<{ clock: SimulationClockState; worldRevision: string; organizationConfig: OrganizationConfig }>((snapshot) => {
      const reconciled = this.computeReconciliation(snapshot, normalizedNow, "admin");
      const replacement = reconciled.replacement;
      const reconciledClock = validateClockState(replacement.clockState ?? reconciled.clock);
      const currentSimulationTime = maxIso(reconciledClock.lastReconciledSimulationTime, maxCurrentTime(replacement.scenarioInstanceStates));
      const nextMode = input.mode ?? reconciledClock.mode;
      const nextPaused = input.paused ?? reconciledClock.paused;
      const nextClock = validateClockState({
        ...reconciledClock,
        mode: nextMode,
        speedMultiplier: input.speedMultiplier ?? reconciledClock.speedMultiplier,
        paused: nextPaused,
        continuousActivity: input.continuousActivity ?? reconciledClock.continuousActivity,
        maxCatchUpSeconds: input.maxCatchUpSeconds ?? reconciledClock.maxCatchUpSeconds,
        wallClockAnchor: reconciled.report.reconciledWallTime,
        simulationClockAnchor: currentSimulationTime,
        lastReconciledWallTime: reconciled.report.reconciledWallTime,
        lastReconciledSimulationTime: currentSimulationTime,
      });
      replacement.clockState = nextClock;
      replacement.orchestrationState = this.applyOrchestrationUpdate(
        replacement.orchestrationState ?? reconciled.orchestration,
        input,
        nextClock.continuousActivity,
      );
      return {
        replacement,
        result: { clock: nextClock, worldRevision: reconciled.worldRevision, organizationConfig: reconciled.organization.config },
      };
    });
    this.observeWorldRevision(output.worldRevision);
    this.observeOrganization(output.organizationConfig);
    return output.clock;
  }

  async pauseClock(now = new Date().toISOString()): Promise<SimulationClockState> {
    return this.updateClock({ paused: true }, now);
  }

  async resumeClock(now = new Date().toISOString()): Promise<SimulationClockState> {
    return this.updateClock({ paused: false }, now);
  }

  async reconcileSimulationClock(input: ReconcileSimulationClockInput = {}): Promise<SimulationReconciliationReport> {
    const now = new Date(input.now ?? new Date().toISOString()).toISOString();
    const trigger = input.trigger ?? "manual";
    const output = await this.storage.mutateWorld<{ report: SimulationReconciliationReport; worldRevision: string; organizationConfig: OrganizationConfig }>((snapshot) => {
      const reconciled = this.computeReconciliation(snapshot, now, trigger);
      return {
        replacement: reconciled.replacement,
        result: { report: reconciled.report, worldRevision: reconciled.worldRevision, organizationConfig: reconciled.organization.config },
      };
    });
    this.observeWorldRevision(output.worldRevision);
    this.observeOrganization(output.organizationConfig);
    return output.report;
  }

  async checkDistributedRateLimit(input: { scope: "admin" | "connection" | "cron"; identityKey: string; limit: number; windowMs: number; nowMs?: number }) {
    if (!this.storage.checkRateLimit) return undefined;
    return this.storage.checkRateLimit({ ...input, nowMs: input.nowMs ?? Date.now() });
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

  async scenarioInstances() {
    return this.storage.listScenarioInstanceStates();
  }

  async scenarioInstance(instanceId: string) {
    const state = await this.requireInstanceState(instanceId);
    return {
      instance: instanceContextFromState(state),
      state,
      events: state.eventLog,
      changes: (await this.sourceChanges()).filter((change) => change.scenarioInstanceId === instanceId),
    };
  }

  async createScenarioInstance(input: ScenarioInstanceCreateInput) {
    const scenario = scenarios.find((candidate) => candidate.id === input.scenarioPackId);
    if (!scenario) throw badRequest(`Unknown scenario pack: ${input.scenarioPackId}`);
    const instanceId = await this.commitInstanceMutation((snapshot) => {
      const existing = snapshot.scenarioInstanceStates;
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
      return { instanceStates: [...existing, state], changedStates: [state], result: state.scenarioInstanceId };
    });
    return this.scenarioInstance(instanceId);
  }

  async sourceChanges(): Promise<SourceChangeLedgerEntry[]> {
    return this.storage.listSourceChanges();
  }

  async sourceObjects(): Promise<SourceObjectProjection[]> {
    return this.storage.listSourceObjects();
  }

  async sourceObject(sourceSystem: string, sourceId: string): Promise<SourceObjectProjection> {
    const object = (await this.sourceObjects()).find((candidate) => candidate.sourceSystem === sourceSystem && candidate.sourceId === sourceId);
    if (!object) throw notFound("Unknown source object");
    return object;
  }

  async sourceObjectHistory(sourceSystem: string, sourceId: string): Promise<SourceChangeLedgerEntry[]> {
    const history = (await this.sourceChanges()).filter((change) => change.sourceSystem === sourceSystem && change.sourceId === sourceId).sort(compareChanges);
    if (history.length === 0) throw notFound("Unknown source object");
    return history;
  }

  async datasetMetadata(): Promise<DatasetMetadata> {
    const metadata = await this.storage.getDatasetMetadata();
    if (metadata) return metadata;
    return this.buildDatasetMetadata(await this.states(), await this.storage.listSourceChanges(), await this.storage.listSourceObjects(), await this.requireWorldRevision());
  }

  async generateDataset(input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}): Promise<DatasetMetadata> {
    const nextSeed = input.seed ?? this.defaultSeed;
    const datasetSize = input.datasetSize ?? this.defaultDatasetSize;
    const startTime = input.startTime ?? DEFAULT_START_TIME;
    const instanceStates = createDatasetInstanceStates(this.organization, nextSeed, datasetSize, startTime, true);
    await this.rotateWorldRevisionFromInstances(`dataset-generate:${datasetSize}:${nextSeed}`, instanceStates, {}, this.currentWorldMutationOptions());
    return this.datasetMetadata();
  }

  async resetDataset(): Promise<DatasetMetadata> {
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

  async putOrganizationConfig(config: OrganizationConfig) {
    this.organizationConfig = cloneOrganizationConfig({ ...config, seed: config.seed || this.organizationConfig.seed });
    return this.regenerateOrganization({ config: this.organizationConfig });
  }

  async regenerateOrganization(input: { seed?: string; config?: OrganizationConfig } = {}) {
    const nextConfig = cloneOrganizationConfig(input.config ?? { ...this.organizationConfig, seed: input.seed ?? this.organizationConfig.seed });
    if (input.seed) nextConfig.seed = input.seed;
    const nextOrganization = buildCompatibleOrganization(nextConfig);
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organization = nextOrganization;
    this.organizationConfig = nextConfig;
    this.connections = createConnections(this.organization);
    try {
      const worldRevision = await this.storage.mutateWorld<string>(
        (snapshot) => {
          const nextStates = rebindInstanceParticipants(this.organization, snapshot.scenarioInstanceStates);
          const worldRevision = this.nextWorldRevision("organization-regenerate", snapshot, nextStates, nextConfig);
          const replacement = this.buildWorldReplacement(nextStates, worldRevision, { organizationConfig: nextConfig });
          return { replacement, result: worldRevision };
        },
        this.currentWorldMutationOptions(),
      );
      this.observeWorldRevision(worldRevision);
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
    return { organization: this.organizationSummary(), previewCounts: previewOrganizationCounts(this.organizationConfig) };
  }

  async resetOrganization() {
    const nextConfig = cloneOrganizationConfig(defaultOrganizationConfig);
    const nextOrganization = buildCompatibleOrganization(nextConfig);
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organizationConfig = nextConfig;
    this.organization = nextOrganization;
    this.connections = createConnections(this.organization);
    try {
      const worldRevision = await this.storage.mutateWorld<string>(
        (snapshot) => {
          const nextStates = rebindInstanceParticipants(this.organization, snapshot.scenarioInstanceStates);
          const worldRevision = this.nextWorldRevision("organization-reset", snapshot, nextStates, nextConfig);
          const replacement = this.buildWorldReplacement(nextStates, worldRevision, { organizationConfig: nextConfig });
          return { replacement, result: worldRevision };
        },
        this.currentWorldMutationOptions(),
      );
      this.observeWorldRevision(worldRevision);
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
    return this.organizationSummary();
  }

  async recordsForPerson(personId: string) {
    const person = this.requirePerson(personId);
    const connection = this.connections.find((candidate) => candidate.id === personConnectionId(person)) ?? connectionForPerson(person);
    const records = (await this.allRecords()).filter((record) => canConnectionSee(record, connection));
    return { person, connection, records };
  }

  async comparePersonVisibility(leftPersonId: string, rightPersonId: string) {
    const left = await this.recordsForPerson(leftPersonId);
    const right = await this.recordsForPerson(rightPersonId);
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

  async resetScenario(scenarioId: string, input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}): Promise<ScenarioInstanceState> {
    return (await this.resetScenarioInstance(defaultInstanceId(scenarioId), input)).state;
  }

  async advanceScenario(scenarioId: string, input: { hours?: number; days?: number } = {}): Promise<ScenarioInstanceState> {
    return (await this.advanceScenarioInstance(defaultInstanceId(scenarioId), input)).state;
  }

  async advanceScenarioInstance(instanceId: string, input: { hours?: number; days?: number } = {}) {
    const hours = clampNumber(input.hours ?? 0, 0, 24 * 365) + clampNumber(input.days ?? 0, 0, 365) * 24;
    await this.commitInstanceMutation((snapshot) => {
      const state = requireInstanceStateFrom(snapshot, instanceId);
      if (state.paused) return { instanceStates: snapshot.scenarioInstanceStates, changedStates: [], result: instanceId };
      const current = new Date(state.currentTime);
      current.setUTCHours(current.getUTCHours() + hours);
      const nextState = finalizeInstanceState(this.organization, this.requireScenario(state.scenarioPackId), { ...state, currentTime: current.toISOString() });
      return { instanceStates: replaceInstanceState(snapshot.scenarioInstanceStates, nextState), changedStates: [nextState], result: instanceId };
    });
    return this.scenarioInstance(instanceId);
  }

  async triggerScenarioEvent(scenarioId: string, eventId: string): Promise<ScenarioInstanceState> {
    return (await this.triggerScenarioInstanceEvent(defaultInstanceId(scenarioId), eventId)).state;
  }

  async triggerScenarioInstanceEvent(instanceId: string, eventId: string) {
    await this.commitInstanceMutation((snapshot) => {
      const state = requireInstanceStateFrom(snapshot, instanceId);
      const scenario = this.requireScenario(state.scenarioPackId);
      const event = scenario.events.find((candidate) => candidate.id === eventId);
      if (!event) throw notFound(`Unknown event: ${eventId}`);
      if (state.triggeredEventIds.includes(event.id)) return { instanceStates: snapshot.scenarioInstanceStates, changedStates: [], result: instanceId };
      const occurredAt = state.currentTime;
      const nextState = finalizeInstanceState(this.organization, scenario, {
        ...state,
        triggeredEventIds: [...state.triggeredEventIds, event.id],
        eventOccurrenceTimes: { ...(state.eventOccurrenceTimes ?? {}), [event.id]: occurredAt },
        eventLog: [...state.eventLog, logEntry(scenario.id, state.scenarioInstanceId, event, occurredAt)],
      });
      return { instanceStates: replaceInstanceState(snapshot.scenarioInstanceStates, nextState), changedStates: [nextState], result: instanceId };
    });
    return this.scenarioInstance(instanceId);
  }

  async triggerScenarioEventForPack(scenarioId: string, eventId: string): Promise<ScenarioInstanceState> {
    const scenario = this.requireScenario(scenarioId);
    const event = scenario.events.find((candidate) => candidate.id === eventId);
    if (!event) throw notFound(`Unknown event: ${eventId}`);
    return this.triggerScenarioEvent(scenarioId, eventId);
  }

  async pauseScenario(scenarioId: string): Promise<ScenarioInstanceState> {
    return (await this.pauseScenarioInstance(defaultInstanceId(scenarioId))).state;
  }

  async pauseScenarioInstance(instanceId: string) {
    await this.commitInstanceMutation((snapshot) => {
      const state = { ...requireInstanceStateFrom(snapshot, instanceId), paused: true };
      return { instanceStates: replaceInstanceState(snapshot.scenarioInstanceStates, state), changedStates: [], result: instanceId };
    });
    return this.scenarioInstance(instanceId);
  }

  async resumeScenario(scenarioId: string): Promise<ScenarioInstanceState> {
    return (await this.resumeScenarioInstance(defaultInstanceId(scenarioId))).state;
  }

  async resumeScenarioInstance(instanceId: string) {
    await this.commitInstanceMutation((snapshot) => {
      const existing = requireInstanceStateFrom(snapshot, instanceId);
      const state = finalizeInstanceState(this.organization, this.requireScenario(existing.scenarioPackId), {
        ...existing,
        paused: false,
      });
      return { instanceStates: replaceInstanceState(snapshot.scenarioInstanceStates, state), changedStates: [state], result: instanceId };
    });
    return this.scenarioInstance(instanceId);
  }

  async resetScenarioInstance(instanceId: string, input: { seed?: string; datasetSize?: DatasetSize; startTime?: string } = {}) {
    const worldRevision = await this.storage.mutateWorld<string>(
      (snapshot) => {
        const existing = requireInstanceStateFrom(snapshot, instanceId);
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
        const nextStates = replaceInstanceState(snapshot.scenarioInstanceStates, resetState);
        const worldRevision = this.nextWorldRevision(`scenario-instance-reset:${instanceId}`, snapshot, nextStates);
        return { replacement: this.buildWorldReplacement(nextStates, worldRevision), result: worldRevision };
      },
      this.currentWorldMutationOptions(),
    );
    this.observeWorldRevision(worldRevision);
    return this.scenarioInstance(instanceId);
  }

  async deleteScenarioInstance(instanceId: string) {
    const worldRevision = await this.storage.mutateWorld(
      (snapshot) => {
        requireInstanceStateFrom(snapshot, instanceId);
        const nextStates = snapshot.scenarioInstanceStates.filter((state) => state.scenarioInstanceId !== instanceId);
        const nextWorldRevision = this.nextWorldRevision(`scenario-instance-delete:${instanceId}`, snapshot, nextStates);
        return { replacement: this.buildWorldReplacement(nextStates, nextWorldRevision), result: nextWorldRevision };
      },
      this.currentWorldMutationOptions(),
    );
    this.observeWorldRevision(worldRevision);
    return {
      deletedScenarioInstanceId: instanceId,
      remainingScenarioInstanceCount: (await this.states()).length,
      worldRevision,
    };
  }

  async state(scenarioId: string): Promise<ScenarioInstanceState> {
    return this.requireInstanceState(defaultInstanceId(scenarioId));
  }

  async states(): Promise<ScenarioInstanceState[]> {
    return this.storage.listScenarioInstanceStates();
  }

  async eventLog(scenarioId: string) {
    return (await this.requireInstanceState(defaultInstanceId(scenarioId))).eventLog;
  }

  async allRecords(): Promise<SourceRecord[]> {
    return (await this.currentSourceObjects()).map((object) => object.record);
  }

  async findRecordForConnection(connectionId: string, sourceSystem: string, sourceId: string): Promise<SourceRecord> {
    const connection = this.requireConnection(connectionId);
    const record = (await this.allRecords()).find((candidate) => candidate.sourceSystem === sourceSystem && candidate.sourceId === sourceId);
    if (!record) throw notFound("Unknown source object");
    if (!canConnectionSee(record, connection)) throw forbidden("Source object is not visible to this connection");
    return record;
  }

  async feed(connectionId: string, cursor: string | undefined, limitInput: number | undefined): Promise<SourceFeedBatchV1> {
    const connection = this.requireConnection(connectionId);
    const worldRevision = await this.requireWorldRevision();
    const cursorPayload = cursor ? decodeCursor(cursor) : { v: 3 as const, connectionId, worldRevision, afterSequence: 0 };
    if (cursorPayload.connectionId !== connectionId) {
      throw badRequest("Cursor does not belong to this connection", "cursor_error");
    }
    if (cursorPayload.worldRevision !== worldRevision) {
      throw badRequest("Stale checkpoint: cursor world revision no longer matches the current simulator world", "stale_cursor");
    }
    const limit = Math.min(Math.max(limitInput ?? 50, 1), MAX_PAGE_SIZE);
    const visibleChanges = (await this.visibleLedgerEntries())
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
      generatedAt: maxCurrentTime(await this.states()),
      records: page.map((change) => change.record),
      nextCursor: encodeCursor({ v: 3, connectionId, worldRevision, afterSequence }),
      hasMore: visibleChanges.length > page.length,
    };
    return SourceFeedBatchV1Schema.parse(batch);
  }

  async createSnapshot(): Promise<Snapshot> {
    const states = await this.states();
    const snapshot: Snapshot = {
      snapshotId: stableId("snapshot", this.stateFingerprintFor(states, this.organization.config)),
      createdAt: maxCurrentTime(states),
      instanceStates: states,
      organizationSeed: this.organization.seed,
      organizationConfig: this.organization.config,
      datasetMetadata: await this.datasetMetadata(),
      worldRevision: await this.requireWorldRevision(),
      clockState: await this.requireClockState(),
      orchestrationState: await this.requireOrchestrationState(await this.requireClockState()),
    };
    await this.storage.createSnapshot(snapshot);
    return snapshot;
  }

  async restoreSnapshot(snapshotId: string): Promise<Snapshot> {
    const snapshot = await this.storage.getSnapshot(snapshotId);
    if (!snapshot) throw notFound(`Unknown snapshot: ${snapshotId}`);
    const previousOrganization = this.organization;
    const previousConfig = this.organizationConfig;
    const previousConnections = this.connections;
    this.organizationConfig = cloneOrganizationConfig(snapshot.organizationConfig);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
    try {
      const restoreInput: { organizationConfig: OrganizationConfig; clockState?: SimulationClockState; orchestrationState?: ContinuousOrchestrationState } = {
        organizationConfig: this.organizationConfig,
      };
      if (snapshot.clockState) restoreInput.clockState = snapshot.clockState;
      if (snapshot.orchestrationState) restoreInput.orchestrationState = snapshot.orchestrationState;
      await this.rotateWorldRevisionFromInstances(
        `snapshot-restore:${snapshotId}`,
        snapshot.instanceStates,
        restoreInput,
        this.currentWorldMutationOptions(),
      );
    } catch (error) {
      this.organization = previousOrganization;
      this.organizationConfig = previousConfig;
      this.connections = previousConnections;
      throw error;
    }
    return snapshot;
  }

  async listSnapshots(): Promise<Snapshot[]> {
    return this.storage.listSnapshots();
  }

  private async requireWorldRevision(): Promise<string> {
    const worldRevision = await this.storage.getWorldRevision();
    if (!worldRevision) {
      throw new Error("Simulator world revision has not been initialized");
    }
    this.observeWorldRevision(worldRevision);
    return worldRevision;
  }

  private async requireClockState(): Promise<SimulationClockState> {
    const state = await this.storage.getClockState();
    if (state) return validateClockState(state);
    const fallback = buildDefaultClockState(DEFAULT_START_TIME);
    await this.storage.saveClockState(fallback);
    return fallback;
  }

  private async requireOrchestrationState(clock: SimulationClockState): Promise<ContinuousOrchestrationState> {
    const state = await this.storage.getOrchestrationState();
    if (state) return validateOrchestrationState(state);
    const fallback = buildDefaultOrchestrationState(clock.lastReconciledSimulationTime, { enabled: clock.continuousActivity });
    await this.storage.saveOrchestrationState(fallback);
    return fallback;
  }

  private computeReconciliation(
    snapshot: WorldSnapshot,
    now: string,
    trigger: SimulationReconciliationReport["trigger"],
  ): {
    replacement: WorldReplacement;
    report: SimulationReconciliationReport;
    worldRevision: string;
    clock: SimulationClockState;
    orchestration: ContinuousOrchestrationState;
    organization: GeneratedOrganization;
  } {
    const worldRevision = snapshot.worldRevision;
    if (!worldRevision) throw new Error("Simulator world revision has not been initialized");
    const organization = buildCompatibleOrganization(snapshot.organizationConfig ?? this.organizationConfig);
    const clock = validateClockState(snapshot.clockState ?? buildDefaultClockState(now));
    const orchestration = validateOrchestrationState(
      snapshot.orchestrationState ?? buildDefaultOrchestrationState(now, { enabled: clock.continuousActivity }),
    );
    const previousWallTime = clock.lastReconciledWallTime;
    const previousSimulationTime = maxIso(clock.lastReconciledSimulationTime, maxCurrentTime(snapshot.scenarioInstanceStates));
    const elapsedWallMs = Math.max(0, Date.parse(now) - Date.parse(previousWallTime));
    const shouldAdvanceSimulation = clock.mode === "realtime" && !clock.paused && elapsedWallMs > 0;
    const catchUpLimitMs = clock.maxCatchUpSeconds * 1_000;
    const wallTimeConsumedMs = shouldAdvanceSimulation ? Math.min(elapsedWallMs, catchUpLimitMs) : elapsedWallMs;
    const wallTimeBacklogRemainingMs = shouldAdvanceSimulation ? Math.max(0, elapsedWallMs - wallTimeConsumedMs) : 0;
    const catchUpLimited = wallTimeBacklogRemainingMs > 0;
    const simulationDeltaMs = shouldAdvanceSimulation ? Math.floor(wallTimeConsumedMs * clock.speedMultiplier) : 0;
    const reconciledWallTime = wallTimeConsumedMs > 0 ? addMilliseconds(previousWallTime, wallTimeConsumedMs) : previousWallTime;
    const reconciledSimulationTime = addMilliseconds(previousSimulationTime, simulationDeltaMs);
    const advancedStates = snapshot.scenarioInstanceStates.map((state) => {
      if (simulationDeltaMs <= 0 || state.paused || state.completionState === "completed") return state;
      const scenario = this.requireScenario(state.scenarioPackId);
      return advanceInstanceForRealtime(organization, scenario, state, addMilliseconds(state.currentTime, simulationDeltaMs));
    });
    const successorOutput = clock.mode === "realtime" && !clock.paused
      ? this.createDueSuccessors(advancedStates, organization, orchestration, reconciledSimulationTime)
      : { states: advancedStates, createdStates: [], orchestration };
    const nextStates = successorOutput.states;
    const changedStateIds = new Set<string>();
    for (const [index, state] of advancedStates.entries()) {
      if (state !== snapshot.scenarioInstanceStates[index]) changedStateIds.add(state.scenarioInstanceId);
    }
    for (const state of successorOutput.createdStates) changedStateIds.add(state.scenarioInstanceId);
    const changedStates = nextStates.filter((state) => changedStateIds.has(state.scenarioInstanceId));
    const beforeChanges = snapshot.sourceChanges.length;
    const nextClock = validateClockState({
      ...clock,
      wallClockAnchor: reconciledWallTime,
      simulationClockAnchor: reconciledSimulationTime,
      lastReconciledWallTime: reconciledWallTime,
      lastReconciledSimulationTime: reconciledSimulationTime,
      reconciliationCount: clock.reconciliationCount + 1,
      totalSimulationTimeAdvancedMs: clock.totalSimulationTimeAdvancedMs + simulationDeltaMs,
    });
    const replacement = this.buildAppendReplacement(snapshot, nextStates, changedStates, worldRevision, {
      clockState: nextClock,
      orchestrationState: successorOutput.orchestration,
    }, organization);
    const objectDelta = countSourceObjectProjectionChanges(snapshot.sourceObjects, replacement.sourceObjects);
    const changesAppended = replacement.sourceChanges.length - beforeChanges;
    const report = buildReconciliationReport({
      trigger,
      previousWallTime,
      reconciledWallTime,
      previousSimulationTime,
      reconciledSimulationTime,
      simulationDeltaMs,
      wallTimeConsumedMs,
      wallTimeBacklogRemainingMs,
      catchUpLimited,
      instancesAdvanced: changedStates.filter((state) => !successorOutput.createdStates.some((created) => created.scenarioInstanceId === state.scenarioInstanceId)).length,
      instancesCreated: successorOutput.createdStates.length,
      changesAppended,
      objectsCreated: objectDelta.created,
      objectsUpdated: objectDelta.updated,
      objectsDeleted: objectDelta.deleted,
      objectsChanged: objectDelta.changed,
      worldRevision,
      alreadyCurrent: simulationDeltaMs === 0 && changesAppended === 0 && successorOutput.createdStates.length === 0 && wallTimeBacklogRemainingMs === 0,
    });
    replacement.clockState = { ...nextClock, lastReconciliationReport: report };
    return { replacement, report, worldRevision, clock: replacement.clockState, orchestration: successorOutput.orchestration, organization };
  }

  private applyOrchestrationUpdate(
    state: ContinuousOrchestrationState,
    input: ClockUpdateInput,
    enabled: boolean,
  ): ContinuousOrchestrationState {
    const profile = input.activityProfile ?? state.activityProfile;
    const profileDefaults = input.activityProfile && input.maxSuccessorInstancesPerReconciliation === undefined && input.minSuccessorIntervalHours === undefined
      ? ACTIVITY_PROFILE_DEFAULTS[profile]
      : undefined;
    return validateOrchestrationState({
      ...state,
      enabled,
      activityProfile: profile,
      maxSuccessorInstancesPerReconciliation:
        input.maxSuccessorInstancesPerReconciliation ??
        profileDefaults?.maxSuccessorInstancesPerReconciliation ??
        state.maxSuccessorInstancesPerReconciliation,
      minSuccessorIntervalHours:
        input.minSuccessorIntervalHours ?? profileDefaults?.minSuccessorIntervalHours ?? state.minSuccessorIntervalHours,
    });
  }

  private createDueSuccessors(
    states: ScenarioInstanceState[],
    organization: GeneratedOrganization,
    orchestration: ContinuousOrchestrationState,
    reconciledSimulationTime: string,
  ): { states: ScenarioInstanceState[]; createdStates: ScenarioInstanceState[]; orchestration: ContinuousOrchestrationState } {
    if (!orchestration.enabled) return { states, createdStates: [], orchestration };
    const existingIds = new Set(states.map((state) => state.scenarioInstanceId));
    const successorDueTimesByCompletedInstanceId = { ...orchestration.successorDueTimesByCompletedInstanceId };
    const eligible = states
      .filter((state) => state.completionState === "completed" && !orchestration.successorByCompletedInstanceId[state.scenarioInstanceId])
      .map((state) => {
        const dueTime = successorDueTimesByCompletedInstanceId[state.scenarioInstanceId] ?? addHours(state.currentTime, orchestration.minSuccessorIntervalHours);
        successorDueTimesByCompletedInstanceId[state.scenarioInstanceId] = dueTime;
        return { state, dueTime };
      })
      .sort((left, right) => Date.parse(left.dueTime) - Date.parse(right.dueTime) || left.state.scenarioInstanceId.localeCompare(right.state.scenarioInstanceId));
    const createdStates: ScenarioInstanceState[] = [];
    const successorByCompletedInstanceId = { ...orchestration.successorByCompletedInstanceId };
    const generationCounters = { ...orchestration.generationCounters };
    for (const { state: completedState, dueTime } of eligible) {
      if (Date.parse(dueTime) > Date.parse(reconciledSimulationTime)) continue;
      if (createdStates.length >= orchestration.maxSuccessorInstancesPerReconciliation) break;
      const scenario = this.requireScenario(completedState.scenarioPackId);
      const nextCounter = (generationCounters[scenario.id] ?? 0) + 1;
      const startTime = dueTime;
      const seed = stableId("successor-seed", completedState.seed, completedState.scenarioInstanceId, String(nextCounter));
      const scenarioInstanceId = `${scenario.id}-continuous-${String(nextCounter).padStart(4, "0")}`;
      if (existingIds.has(scenarioInstanceId)) {
        generationCounters[scenario.id] = nextCounter;
        continue;
      }
      const created = createScenarioInstanceState(organization, scenario, {
        scenarioPackId: scenario.id,
        scenarioInstanceId,
        instanceIndex: nextCounter,
        seed,
        datasetSize: completedState.datasetSize,
        startTime,
        account: completedState.account,
        product: completedState.product,
        project: completedState.project,
        service: completedState.service,
        workstream: completedState.workstream,
        participantPersonIds: completedState.participantPersonIds,
        completed: false,
      });
      generationCounters[scenario.id] = nextCounter;
      successorByCompletedInstanceId[completedState.scenarioInstanceId] = created.scenarioInstanceId;
      existingIds.add(created.scenarioInstanceId);
      createdStates.push(created);
    }
    if (createdStates.length === 0) {
      return {
        states,
        createdStates,
        orchestration: validateOrchestrationState({
          ...orchestration,
          successorDueTimesByCompletedInstanceId,
          generationCounters,
          successorByCompletedInstanceId,
          nextScheduledInstanceTime:
            nextPendingSuccessorTime(successorDueTimesByCompletedInstanceId, successorByCompletedInstanceId) ??
            addHours(reconciledSimulationTime, orchestration.minSuccessorIntervalHours),
        }),
      };
    }
    const recentSuccessorInstanceIds = [...orchestration.recentSuccessorInstanceIds, ...createdStates.map((state) => state.scenarioInstanceId)].slice(-25);
    return {
      states: [...states, ...createdStates],
      createdStates,
      orchestration: {
        ...orchestration,
        cycleNumber: orchestration.cycleNumber + createdStates.length,
        generationCounters,
        successorByCompletedInstanceId,
        successorDueTimesByCompletedInstanceId,
        lastCreatedInstanceId: createdStates[createdStates.length - 1]!.scenarioInstanceId,
        recentSuccessorInstanceIds,
        nextScheduledInstanceTime: nextPendingSuccessorTime(successorDueTimesByCompletedInstanceId, successorByCompletedInstanceId) ?? addHours(reconciledSimulationTime, orchestration.minSuccessorIntervalHours),
      },
    };
  }

  private async rotateWorldRevisionFromInstances(
    reason: string,
    instanceStates: ScenarioInstanceState[],
    input: { organizationConfig?: OrganizationConfig; clockState?: SimulationClockState; orchestrationState?: ContinuousOrchestrationState } = {},
    options: { expectedWorldRevision?: string } = {},
  ): Promise<void> {
    const worldRevision = await this.storage.mutateWorld(
      (snapshot) => {
        const nextWorldRevision = this.nextWorldRevision(reason, snapshot, instanceStates, input.organizationConfig ?? this.organizationConfig);
        return { replacement: this.buildWorldReplacement(instanceStates, nextWorldRevision, input), result: nextWorldRevision };
      },
      options,
    );
    this.observeWorldRevision(worldRevision);
  }

  private async replaceWorldFromInstances(
    instanceStates: ScenarioInstanceState[],
    worldRevision: string,
    input: { organizationConfig?: OrganizationConfig; clockState?: SimulationClockState; orchestrationState?: ContinuousOrchestrationState } = {},
  ): Promise<void> {
    await this.storage.replaceWorld(this.buildWorldReplacement(instanceStates, worldRevision, input));
    this.observeWorldRevision(worldRevision);
  }

  private async commitInstanceMutation<T>(mutation: (snapshot: WorldSnapshot) => { instanceStates: ScenarioInstanceState[]; changedStates: ScenarioInstanceState[]; result: T }): Promise<T> {
    const output = await this.storage.mutateWorld((snapshot) => {
      const worldRevision = snapshot.worldRevision;
      if (!worldRevision) throw new Error("Simulator world revision has not been initialized");
      const { instanceStates, changedStates, result } = mutation(snapshot);
      const replacement = this.buildAppendReplacement(snapshot, instanceStates, changedStates, worldRevision);
      return { replacement, result: { value: result, worldRevision } };
    });
    this.observeWorldRevision(output.worldRevision);
    return output.value;
  }

  private buildAppendReplacement(
    snapshot: WorldSnapshot,
    instanceStates: ScenarioInstanceState[],
    changedStates: ScenarioInstanceState[],
    worldRevision: string,
    runtimeState: { clockState?: SimulationClockState; orchestrationState?: ContinuousOrchestrationState } = {},
    organization: GeneratedOrganization = this.organization,
  ): WorldReplacement {
    const existingChanges = snapshot.sourceChanges;
    const existingChangeIds = new Set(existingChanges.map((change) => change.changeId));
    const newChanges = changedStates
      .flatMap((state) => this.changesForInstanceState(state, worldRevision, organization))
      .filter((change) => !existingChangeIds.has(change.changeId))
      .sort(compareLedgerDrafts);
    const nextSequence = (existingChanges.at(-1)?.ledgerSequence ?? 0) + 1;
    const sourceChanges = [
      ...existingChanges,
      ...assignLedgerSequences(newChanges, nextSequence),
    ].sort(compareChanges);
    const sourceObjects = this.projectCurrentSourceObjects(sourceChanges);
    return {
      scenarioInstanceStates: instanceStates,
      worldRevision,
      sourceChanges,
      sourceObjects,
      datasetMetadata: this.buildDatasetMetadata(instanceStates, sourceChanges, sourceObjects, worldRevision, organization.config),
      ...(runtimeState.clockState ?? snapshot.clockState ? { clockState: runtimeState.clockState ?? snapshot.clockState } : {}),
      ...(runtimeState.orchestrationState ?? snapshot.orchestrationState
        ? { orchestrationState: runtimeState.orchestrationState ?? snapshot.orchestrationState }
        : {}),
    };
  }

  private async visibleLedgerEntries(): Promise<SourceChangeLedgerEntry[]> {
    return (await this.storage.listSourceChanges()).sort(compareChanges);
  }

  private async currentSourceObjects(): Promise<SourceObjectProjection[]> {
    return this.projectCurrentSourceObjects(await this.visibleLedgerEntries());
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

  private buildWorldReplacement(
    instanceStates: ScenarioInstanceState[],
    worldRevision: string,
    input: { organizationConfig?: OrganizationConfig; clockState?: SimulationClockState; orchestrationState?: ContinuousOrchestrationState } = {},
  ): WorldReplacement {
    const organization = input.organizationConfig ? buildCompatibleOrganization(input.organizationConfig) : this.organization;
    const changes = assignLedgerSequences(
      instanceStates.flatMap((state) => this.changesForInstanceState(state, worldRevision, organization)),
      1,
    );
    const sourceObjects = this.projectCurrentSourceObjects(changes);
    return {
      scenarioInstanceStates: instanceStates,
      ...(input.organizationConfig ? { organizationConfig: input.organizationConfig } : {}),
      worldRevision,
      sourceChanges: changes,
      sourceObjects,
      datasetMetadata: this.buildDatasetMetadata(instanceStates, changes, sourceObjects, worldRevision, organization.config),
      ...(input.clockState ? { clockState: input.clockState } : {}),
      ...(input.orchestrationState ? { orchestrationState: input.orchestrationState } : {}),
    };
  }

  private nextWorldRevision(
    reason: string,
    snapshot: WorldSnapshot,
    instanceStates: ScenarioInstanceState[],
    organizationConfig: OrganizationConfig = this.organizationConfig,
  ): string {
    return stableId("world", reason, snapshot.worldRevision ?? "none", this.stateFingerprintFor(instanceStates, organizationConfig));
  }

  private observeWorldRevision(worldRevision: string | undefined): void {
    if (worldRevision) this.knownWorldRevision = worldRevision;
  }

  private observeOrganization(config: OrganizationConfig | undefined): void {
    if (!config) return;
    this.organizationConfig = cloneOrganizationConfig(config);
    this.organization = buildCompatibleOrganization(this.organizationConfig);
    this.connections = createConnections(this.organization);
  }

  private currentWorldMutationOptions(): { expectedWorldRevision?: string } {
    return this.knownWorldRevision ? { expectedWorldRevision: this.knownWorldRevision } : {};
  }

  private changesForInstanceState(state: ScenarioInstanceState, worldRevision: string, organization: GeneratedOrganization = this.organization): SourceChangeLedgerEntry[] {
    const scenario = this.requireScenario(state.scenarioPackId);
    return scenario.events.flatMap((event) => {
      if (!hasEventOccurred(state, event)) return [];
      return event.records.flatMap((template) => {
        const records = [materializeRecord(this.baseUrl, state, scenario, event, template, organization, state, "created")];
        if (template.updatedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, organization, state, "updated"));
        }
        if (template.deletedAfterHours !== undefined) {
          records.push(materializeRecord(this.baseUrl, state, scenario, event, template, organization, state, "deleted"));
        }
        return records
          .filter((record) => Date.parse(record.changeOccurredAt) <= Date.parse(state.currentTime))
          .map((record) => ledgerEntry(worldRevision, scenario, event, state, template, record));
      });
    });
  }

  private buildDatasetMetadata(
    instanceStates: ScenarioInstanceState[],
    changes: SourceChangeLedgerEntry[],
    objects: SourceObjectProjection[],
    worldRevision: string,
    organizationConfig: OrganizationConfig = this.organizationConfig,
  ): DatasetMetadata {
    const firstState = instanceStates[0];
    const countsBySourceSystem = Object.fromEntries(sourceSystems.map((source) => [source, 0])) as DatasetMetadata["countsBySourceSystem"];
    for (const change of changes) countsBySourceSystem[change.sourceSystem] += 1;
    return {
      schemaVersion: "dataset-metadata.v1",
      datasetId: stableId("dataset", this.stateFingerprintFor(instanceStates, organizationConfig), String(changes.length)),
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

  private async requireInstanceState(instanceId: string): Promise<ScenarioInstanceState> {
    const state = await this.storage.getScenarioInstanceState(instanceId);
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
  const lifecycleComplete = isScenarioLifecycleComplete(scenario, state.currentTime, state.startedAt);
  const eventLog = scenario.events
    .filter((event) => eventIds.has(event.id))
    .map((event) => logEntry(scenario.id, state.scenarioInstanceId, event, eventOccurrenceTimes[event.id] ?? addHours(state.startedAt, event.atHour)));
  return {
    ...state,
    triggeredEventIds: [...eventIds],
    eventOccurrenceTimes,
    eventLog: eventLog.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.eventId.localeCompare(right.eventId)),
    completionState: lifecycleComplete ? "completed" : "active",
  };
}

function advanceInstanceForRealtime(
  organization: GeneratedOrganization,
  scenario: ScenarioDefinition,
  state: ScenarioInstanceState,
  currentTime: string,
): ScenarioInstanceState {
  const triggeredEventIds = new Set(state.triggeredEventIds);
  const eventOccurrenceTimes = { ...(state.eventOccurrenceTimes ?? {}) };
  const currentMs = Date.parse(currentTime);
  for (const event of scenario.events) {
    if (event.manual) continue;
    const scheduledAt = addHours(state.startedAt, event.atHour);
    if (Date.parse(scheduledAt) <= currentMs) {
      triggeredEventIds.add(event.id);
      eventOccurrenceTimes[event.id] ??= scheduledAt;
    }
  }
  return finalizeInstanceState(organization, scenario, {
    ...state,
    currentTime,
    triggeredEventIds: [...triggeredEventIds],
    eventOccurrenceTimes,
  });
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
    throw badRequest("Invalid cursor", "cursor_error");
  }
}

function sourceKey(sourceSystem: string, sourceId: string): string {
  return `${sourceSystem}:${sourceId}`;
}

function countSourceObjectProjectionChanges(before: SourceObjectProjection[], after: SourceObjectProjection[]): { created: number; updated: number; deleted: number; changed: number } {
  const beforeByKey = new Map(before.map((object) => [object.sourceKey, object]));
  let created = 0;
  let updated = 0;
  let deleted = 0;
  for (const object of after) {
    const previous = beforeByKey.get(object.sourceKey);
    if (previous?.currentChangeId === object.currentChangeId && previous.currentChangeType === object.currentChangeType) continue;
    if (object.currentChangeType === "created") created += 1;
    else if (object.currentChangeType === "updated") updated += 1;
    else if (object.currentChangeType === "deleted") deleted += 1;
  }
  return { created, updated, deleted, changed: created + updated + deleted };
}

function nextPendingSuccessorTime(
  dueTimesByCompletedInstanceId: Record<string, string>,
  successorByCompletedInstanceId: Record<string, string>,
): string | undefined {
  return Object.entries(dueTimesByCompletedInstanceId)
    .filter(([completedInstanceId]) => !successorByCompletedInstanceId[completedInstanceId])
    .map(([, dueTime]) => dueTime)
    .sort()[0];
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

const SimulationReconciliationReportSchema = z
  .object({
    schemaVersion: z.literal("simulation-reconciliation.v1"),
    trigger: z.enum(["manual", "feed", "cron", "startup", "admin"]),
    previousWallTime: z.string().datetime(),
    reconciledWallTime: z.string().datetime(),
    previousSimulationTime: z.string().datetime(),
    reconciledSimulationTime: z.string().datetime(),
    simulationDeltaMs: z.number().int().min(0),
    wallTimeConsumedMs: z.number().int().min(0).default(0),
    wallTimeBacklogRemainingMs: z.number().int().min(0).default(0),
    catchUpLimited: z.boolean().default(false),
    instancesAdvanced: z.number().int().min(0),
    instancesCreated: z.number().int().min(0),
    changesAppended: z.number().int().min(0),
    objectsCreated: z.number().int().min(0).default(0),
    objectsUpdated: z.number().int().min(0).default(0),
    objectsDeleted: z.number().int().min(0).default(0),
    objectsChanged: z.number().int().min(0),
    worldRevision: z.string().min(1),
    alreadyCurrent: z.boolean(),
  })
  .strict();

const SimulationClockStateSchema = z
  .object({
    schemaVersion: z.literal("simulation-clock.v1"),
    mode: z.enum(["manual", "realtime"]),
    wallClockAnchor: z.string().datetime(),
    simulationClockAnchor: z.string().datetime(),
    lastReconciledWallTime: z.string().datetime(),
    lastReconciledSimulationTime: z.string().datetime(),
    speedMultiplier: z.number().positive().max(MAX_CLOCK_SPEED_MULTIPLIER),
    paused: z.boolean(),
    continuousActivity: z.boolean(),
    maxCatchUpSeconds: z.number().int().min(1).max(60 * 60 * 24 * 7),
    reconciliationCount: z.number().int().min(0),
    totalSimulationTimeAdvancedMs: z.number().int().min(0),
    lastReconciliationReport: SimulationReconciliationReportSchema.optional(),
  })
  .strict();

const ContinuousOrchestrationStateSchema = z
  .object({
    schemaVersion: z.literal("continuous-orchestration.v1"),
    enabled: z.boolean(),
    activityProfile: z.enum(["standard", "quiet", "intense"]),
    cycleNumber: z.number().int().min(0),
    generationCounters: z.record(z.string(), z.number().int().min(0)),
    successorByCompletedInstanceId: z.record(z.string(), z.string()),
    successorDueTimesByCompletedInstanceId: z.record(z.string(), z.string().datetime()).default({}),
    nextScheduledInstanceTime: z.string().datetime(),
    lastCreatedInstanceId: z.string().optional(),
    recentSuccessorInstanceIds: z.array(z.string()).max(100),
    maxSuccessorInstancesPerReconciliation: z.number().int().min(0).max(100),
    minSuccessorIntervalHours: z.number().int().min(0).max(24 * 30),
  })
  .strict();

function buildDefaultClockState(
  now: string,
  input: Partial<Pick<SimulationClockState, "mode" | "speedMultiplier" | "continuousActivity" | "maxCatchUpSeconds">> = {},
): SimulationClockState {
  const normalizedNow = new Date(now).toISOString();
  return validateClockState({
    schemaVersion: "simulation-clock.v1",
    mode: input.mode ?? "manual",
    wallClockAnchor: normalizedNow,
    simulationClockAnchor: normalizedNow,
    lastReconciledWallTime: normalizedNow,
    lastReconciledSimulationTime: normalizedNow,
    speedMultiplier: input.speedMultiplier ?? DEFAULT_CLOCK_SPEED_MULTIPLIER,
    paused: false,
    continuousActivity: input.continuousActivity ?? false,
    maxCatchUpSeconds: input.maxCatchUpSeconds ?? DEFAULT_MAX_CATCH_UP_SECONDS,
    reconciliationCount: 0,
    totalSimulationTimeAdvancedMs: 0,
  });
}

function buildDefaultOrchestrationState(
  now: string,
  input: Partial<Pick<ContinuousOrchestrationState, "enabled" | "maxSuccessorInstancesPerReconciliation" | "minSuccessorIntervalHours">> = {},
): ContinuousOrchestrationState {
  return validateOrchestrationState({
    schemaVersion: "continuous-orchestration.v1",
    enabled: input.enabled ?? false,
    activityProfile: "standard",
    cycleNumber: 0,
    generationCounters: {},
    successorByCompletedInstanceId: {},
    successorDueTimesByCompletedInstanceId: {},
    nextScheduledInstanceTime: new Date(now).toISOString(),
    recentSuccessorInstanceIds: [],
    maxSuccessorInstancesPerReconciliation: input.maxSuccessorInstancesPerReconciliation ?? DEFAULT_MAX_SUCCESSORS_PER_RECONCILIATION,
    minSuccessorIntervalHours: input.minSuccessorIntervalHours ?? DEFAULT_MIN_SUCCESSOR_INTERVAL_HOURS,
  });
}

function validateClockState(state: SimulationClockState): SimulationClockState {
  const parsed = SimulationClockStateSchema.parse(state);
  if (Date.parse(parsed.lastReconciledSimulationTime) < Date.parse(parsed.simulationClockAnchor)) {
    throw badRequest("Simulation clock state cannot move backward", "clock_validation_error");
  }
  return parsed as SimulationClockState;
}

function validateOrchestrationState(state: ContinuousOrchestrationState): ContinuousOrchestrationState {
  return ContinuousOrchestrationStateSchema.parse(state) as ContinuousOrchestrationState;
}

function validateClockUpdate(input: ClockUpdateInput): void {
  if (input.speedMultiplier !== undefined && (input.speedMultiplier <= 0 || input.speedMultiplier > MAX_CLOCK_SPEED_MULTIPLIER)) {
    throw badRequest("Clock speed multiplier is out of bounds", "clock_validation_error");
  }
  if (input.mode === "realtime" && input.speedMultiplier === 0) {
    throw badRequest("Realtime mode requires a positive speed multiplier", "clock_validation_error");
  }
  if (input.maxCatchUpSeconds !== undefined && (!Number.isInteger(input.maxCatchUpSeconds) || input.maxCatchUpSeconds < 1 || input.maxCatchUpSeconds > 60 * 60 * 24 * 7)) {
    throw badRequest("Clock catch-up window is out of bounds", "clock_validation_error");
  }
  if (input.activityProfile !== undefined && !(input.activityProfile in ACTIVITY_PROFILE_DEFAULTS)) {
    throw badRequest("Clock activity profile is out of bounds", "clock_validation_error");
  }
  if (
    input.maxSuccessorInstancesPerReconciliation !== undefined &&
    (!Number.isInteger(input.maxSuccessorInstancesPerReconciliation) || input.maxSuccessorInstancesPerReconciliation < 0 || input.maxSuccessorInstancesPerReconciliation > 100)
  ) {
    throw badRequest("Clock successor creation bound is out of bounds", "clock_validation_error");
  }
  if (
    input.minSuccessorIntervalHours !== undefined &&
    (!Number.isInteger(input.minSuccessorIntervalHours) || input.minSuccessorIntervalHours < 0 || input.minSuccessorIntervalHours > 24 * 30)
  ) {
    throw badRequest("Clock successor interval is out of bounds", "clock_validation_error");
  }
}

function buildReconciliationReport(input: Omit<SimulationReconciliationReport, "schemaVersion">): SimulationReconciliationReport {
  return SimulationReconciliationReportSchema.parse({ schemaVersion: "simulation-reconciliation.v1", ...input });
}

function addHours(start: string, hours: number): string {
  const date = new Date(start);
  date.setUTCHours(date.getUTCHours() + hours);
  return date.toISOString();
}

function addMilliseconds(start: string, milliseconds: number): string {
  return new Date(Date.parse(start) + milliseconds).toISOString();
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
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

function requireInstanceStateFrom(snapshot: WorldSnapshot, instanceId: string): ScenarioInstanceState {
  const state = snapshot.scenarioInstanceStates.find((candidate) => candidate.scenarioInstanceId === instanceId);
  if (!state) throw notFound(`Unknown scenario instance: ${instanceId}`);
  return state;
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

function isScenarioLifecycleComplete(scenario: ScenarioDefinition, currentTime: string, startedAt: string): boolean {
  return Date.parse(currentTime) >= Date.parse(scenarioLifecycleCompleteAt(scenario, startedAt));
}

function scenarioLifecycleCompleteAt(scenario: ScenarioDefinition, startedAt: string): string {
  const nonmanualEvents = scenario.events.filter((event) => !event.manual);
  if (nonmanualEvents.length === 0) return startedAt;
  const horizonHours = Math.max(
    ...nonmanualEvents.map((event) => {
      const recordHorizon = Math.max(
        0,
        ...event.records.map((record) => Math.max(record.visibleAfterHours ?? 0, record.updatedAfterHours ?? 0, record.deletedAfterHours ?? 0)),
      );
      return event.atHour + recordHorizon;
    }),
  );
  return addHours(startedAt, horizonHours);
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
    public readonly classification = "request_error",
  ) {
    super(message);
  }
}

export function badRequest(message: string, classification = "request_validation_error"): HttpError {
  return new HttpError(400, message, classification);
}

export function forbidden(message: string, classification = "authorization_error"): HttpError {
  return new HttpError(403, message, classification);
}

export function notFound(message: string, classification = "not_found"): HttpError {
  return new HttpError(404, message, classification);
}
