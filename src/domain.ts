export const departments = ["product", "engineering", "customer_success"] as const;
export const roleLevels = ["ic", "manager", "director", "vp"] as const;
export const datasetSizes = ["small", "medium", "large"] as const;
export const sourceSystems = [
  "slack",
  "gmail",
  "calendar",
  "notion",
  "jira",
  "productboard",
  "amplitude",
  "github",
  "pagerduty",
  "salesforce",
  "gainsight",
  "zendesk",
] as const;

export type Department = (typeof departments)[number];
export type RoleLevel = (typeof roleLevels)[number];
export type DatasetSize = (typeof datasetSizes)[number];
export type SourceSystem = (typeof sourceSystems)[number];
export type AclVisibility = "public" | "group" | "restricted" | "private";
export type SourceChangeType = "created" | "updated" | "deleted";

export interface Acl {
  visibility: AclVisibility;
  groups: string[];
  users: string[];
}

export interface DepartmentOrgConfig {
  vpCount: number;
  directorsPerVp: number;
  managersPerDirector: number;
  icsPerManager: number;
  customDirectorsPerVp?: Record<string, number>;
  customManagersPerDirector?: Record<string, number>;
  customIcsPerManager?: Record<string, number>;
}

export interface OrganizationConfig {
  seed: string;
  departments: Record<Department, DepartmentOrgConfig>;
}

export interface RoleTemplate {
  id: string;
  department: Department;
  roleLevel: RoleLevel;
  title: string;
  description: string;
}

export interface Team {
  id: string;
  name: string;
  department: Department;
  level: "department" | "director_group" | "manager_team" | "project";
  leadPersonId: string | null;
  parentTeamId: string | null;
  memberPersonIds: string[];
  responsibilityScopes: string[];
}

export interface Person {
  id: string;
  stableKey: string;
  name: string;
  email: string;
  department: Department;
  roleTemplateId: string;
  roleTitle: string;
  roleLevel: RoleLevel;
  teamId: string;
  managerId: string | null;
  directReportIds: string[];
  sourceIdentities: Partial<Record<SourceSystem, string>>;
  groupMemberships: string[];
  assignedProjects: string[];
  assignedProducts: string[];
  assignedAccounts: string[];
  assignedWorkstreams: string[];
  permissionScopes: string[];
}

export interface ReportingRelationship {
  managerId: string;
  reportId: string;
  relationshipType: "primary" | "dotted_line";
  context: string | null;
}

export interface OrganizationNode {
  personId: string;
  name: string;
  roleTitle: string;
  roleLevel: RoleLevel;
  department: Department;
  teamId: string;
  directReports: OrganizationNode[];
}

export interface GeneratedOrganization {
  seed: string;
  config: OrganizationConfig;
  roleTemplates: RoleTemplate[];
  people: Person[];
  teams: Team[];
  reportingRelationships: ReportingRelationship[];
  tree: OrganizationNode[];
  counts: {
    totalPeople: number;
    byDepartment: Record<Department, number>;
    byRoleLevel: Record<RoleLevel, number>;
  };
  validation: {
    ok: boolean;
    errors: string[];
  };
}

export interface SourceConnection {
  id: string;
  tenantId: string;
  personId: string;
  roleTemplateId: string;
  label: string;
  allowedSources: SourceSystem[];
  allowedGroups: string[];
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export interface SourceRecord {
  schemaVersion: "source-record.v1";
  sourceSystem: SourceSystem;
  sourceId: string;
  objectType: string;
  occurredAt: string;
  updatedAt?: string;
  title: string;
  sourceUrl: string;
  actorRef?: string;
  acl: Acl;
  rawPayload: Record<string, unknown>;
  changeId: string;
  changeType: SourceChangeType;
  changeSequence: number;
  changeOccurredAt: string;
  correlation: {
    scenarioId: string;
    eventId: string;
    templateId: string;
    seedFingerprint: string;
  };
}

export interface SourceChangeLedgerEntry {
  ledgerSequence: number;
  worldRevision: string;
  changeId: string;
  changeType: SourceChangeType;
  sourceSystem: SourceSystem;
  sourceId: string;
  changeOccurredAt: string;
  sourceOccurredAt: string;
  scenarioId: string;
  scenarioPackId: string;
  scenarioInstanceId: string;
  businessEventId: string;
  templateId: string;
  record: SourceRecord;
  permissionScope: Acl;
}

export interface SourceObjectProjection {
  sourceKey: string;
  worldRevision: string;
  sourceSystem: SourceSystem;
  sourceId: string;
  currentChangeId: string;
  currentChangeType: SourceChangeType;
  record: SourceRecord;
}

export interface ScenarioRecordTemplate {
  id: string;
  sourceSystem: SourceSystem;
  objectType: string;
  title: string;
  actorRoleTemplateId: string;
  assignmentRoleTemplateId?: string;
  aclUserRoleTemplateIds?: string[];
  acl: Acl;
  rawPayload: Record<string, unknown>;
  visibleAfterHours?: number;
  updatedAfterHours?: number;
  deletedAfterHours?: number;
}

export interface ScenarioEventTemplate {
  id: string;
  label: string;
  atHour: number;
  manual?: boolean;
  records: ScenarioRecordTemplate[];
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  department: Department | "cross_functional";
  description: string;
  participantRoleTemplateIds: string[];
  sourceSystems: SourceSystem[];
  events: ScenarioEventTemplate[];
}

export interface ScenarioInstanceContext {
  scenarioPackId: string;
  scenarioInstanceId: string;
  instanceIndex: number;
  label: string;
  seed: string;
  account: string;
  product: string;
  project: string;
  service: string;
  workstream: string;
  timeOffsetHours: number;
}

export type ScenarioCompletionState = "active" | "completed";

export interface DatasetMetadata {
  schemaVersion: "dataset-metadata.v1";
  datasetId: string;
  seed: string;
  datasetSize: DatasetSize;
  generatedAt: string;
  scenarioPackCount: number;
  scenarioInstanceCount: number;
  totalSourceChanges: number;
  totalSourceObjects: number;
  countsBySourceSystem: Record<SourceSystem, number>;
  worldRevision: string;
}

export type SimulationClockMode = "manual" | "realtime";

export interface SimulationReconciliationReport {
  schemaVersion: "simulation-reconciliation.v1";
  trigger: "manual" | "feed" | "cron" | "startup" | "admin";
  previousWallTime: string;
  reconciledWallTime: string;
  previousSimulationTime: string;
  reconciledSimulationTime: string;
  simulationDeltaMs: number;
  wallTimeConsumedMs: number;
  wallTimeBacklogRemainingMs: number;
  catchUpLimited: boolean;
  instancesAdvanced: number;
  instancesCreated: number;
  changesAppended: number;
  objectsCreated: number;
  objectsUpdated: number;
  objectsDeleted: number;
  objectsChanged: number;
  worldRevision: string;
  alreadyCurrent: boolean;
}

export interface SimulationClockState {
  schemaVersion: "simulation-clock.v1";
  mode: SimulationClockMode;
  wallClockAnchor: string;
  simulationClockAnchor: string;
  lastReconciledWallTime: string;
  lastReconciledSimulationTime: string;
  speedMultiplier: number;
  paused: boolean;
  continuousActivity: boolean;
  maxCatchUpSeconds: number;
  reconciliationCount: number;
  totalSimulationTimeAdvancedMs: number;
  lastReconciliationReport?: SimulationReconciliationReport;
}

export interface ContinuousOrchestrationState {
  schemaVersion: "continuous-orchestration.v1";
  enabled: boolean;
  activityProfile: "standard" | "quiet" | "intense";
  cycleNumber: number;
  generationCounters: Record<string, number>;
  successorByCompletedInstanceId: Record<string, string>;
  successorDueTimesByCompletedInstanceId: Record<string, string>;
  nextScheduledInstanceTime: string;
  lastCreatedInstanceId?: string;
  recentSuccessorInstanceIds: string[];
  maxSuccessorInstancesPerReconciliation: number;
  minSuccessorIntervalHours: number;
}

export interface ScenarioEventLogEntry {
  scenarioId: string;
  scenarioInstanceId?: string;
  eventId: string;
  label: string;
  occurredAt: string;
  recordTemplateIds: string[];
}

export interface ScenarioState {
  scenarioId: string;
  seed: string;
  datasetSize: DatasetSize;
  startedAt: string;
  currentTime: string;
  paused: boolean;
  triggeredEventIds: string[];
  eventLog: ScenarioEventLogEntry[];
}

export interface ScenarioInstanceState extends ScenarioInstanceContext {
  seed: string;
  datasetSize: DatasetSize;
  startedAt: string;
  currentTime: string;
  paused: boolean;
  triggeredEventIds: string[];
  eventOccurrenceTimes: Record<string, string>;
  eventLog: ScenarioEventLogEntry[];
  completionState: ScenarioCompletionState;
  participantPersonIds: Record<string, string>;
}

export interface Snapshot {
  snapshotId: string;
  createdAt: string;
  instanceStates: ScenarioInstanceState[];
  organizationSeed: string;
  organizationConfig: OrganizationConfig;
  datasetMetadata?: DatasetMetadata;
  worldRevision?: string;
  clockState?: SimulationClockState;
  orchestrationState?: ContinuousOrchestrationState;
}
