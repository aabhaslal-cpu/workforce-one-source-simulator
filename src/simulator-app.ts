import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  SourceSimulator,
  HttpError,
  badRequest,
  validateOrganizationConfigCompatibility,
  type ClockUpdateInput,
  type ScenarioInstanceCreateInput,
  type SimulatorOptions,
} from "./engine.js";
import { scenarios } from "./data.js";
import { previewOrganizationCounts, roleTemplates } from "./organization.js";
import {
  MemorySimulatorStorage,
  PostgresSimulatorStorage,
  SQLiteSimulatorStorage,
  StorageError,
  WorldConflictError,
  type SimulatorStorage,
} from "./storage.js";
import {
  datasetSizes,
  sourceSystems,
  type DatasetSize,
  type OrganizationConfig,
} from "./domain.js";
import {
  applyFeedFailure,
  FailureController,
  FailureModeConfigSchema,
  parseFailureConfig,
  type FailureDecision,
} from "./failures.js";
import { OperationalTelemetry, type RequestTelemetryInput } from "./observability.js";
import { BenchmarkRequestSchema, runPerformanceBenchmark } from "./performance.js";
import { runConnectorTestKit } from "./connector-kit.js";
import { buildRateLimitConfig, RateLimiter } from "./rate-limit.js";

export interface AppOptions {
  simulator?: SourceSimulator;
  adminKey?: string;
  connectionCredentials?: Record<string, string>;
  revokedConnectionCredentials?: string[];
  runtimeEnv?: RuntimeEnv;
  storage?: SimulatorStorage;
  rateLimitConfigJson?: string;
  feedReconciliationMaxCatchUpSeconds?: number;
}

type RuntimeEnv = "development" | "test" | "preview" | "production";
type ScenarioResetInput = { seed?: string; datasetSize?: DatasetSize; startTime?: string };
type ScenarioAdvanceInput = { hours?: number; days?: number };
type OrganizationGenerateInput = { seed?: string; config?: OrganizationConfig };
type DatasetGenerateInput = { seed?: string; datasetSize?: DatasetSize; startTime?: string };

const DEV_ADMIN_KEY = "dev-admin-key";
const DEV_CONNECTION_PREFIX = "dev-connection-secret";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_VPS = 3;
const MAX_DIRECTORS_PER_VP = 8;
const MAX_MANAGERS_PER_DIRECTOR = 10;
const MAX_ICS_PER_MANAGER = 25;
const MAX_TOTAL_PEOPLE = 500;
const DEFAULT_FEED_RECONCILIATION_MAX_CATCH_UP_SECONDS = 5 * 60;

const DatasetSizeSchema = z.enum(datasetSizes);
const BoundedSeedSchema = z.string().min(1).max(128);
const ScenarioResetSchema = z
  .object({
    seed: BoundedSeedSchema.optional(),
    datasetSize: DatasetSizeSchema.optional(),
    startTime: z.string().datetime().optional(),
  })
  .strict();
const ScenarioAdvanceSchema = z
  .object({
    hours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30)
      .optional(),
    days: z.number().int().min(0).max(30).optional(),
  })
  .strict()
  .refine(
    (input) => input.hours !== undefined || input.days !== undefined,
    "hours or days is required",
  );
const TriggerSchema = z.object({ eventId: z.string().min(1).max(100) }).strict();
const EmptyBodySchema = z.object({}).strict();
const PaginationSchema = z
  .object({
    cursor: z.string().min(1).max(MAX_CURSOR_BYTES).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();
const SnapshotParamsSchema = z.object({ snapshotId: z.string().min(1).max(128) }).strict();
const OverrideDirectorsSchema = z.record(
  z.string().min(1).max(96),
  z.number().int().min(0).max(MAX_DIRECTORS_PER_VP),
);
const OverrideManagersSchema = z.record(
  z.string().min(1).max(96),
  z.number().int().min(0).max(MAX_MANAGERS_PER_DIRECTOR),
);
const OverrideIcsSchema = z.record(
  z.string().min(1).max(96),
  z.number().int().min(0).max(MAX_ICS_PER_MANAGER),
);
const DepartmentOrgConfigSchema = z
  .object({
    vpCount: z.number().int().min(0).max(MAX_VPS),
    directorsPerVp: z.number().int().min(0).max(MAX_DIRECTORS_PER_VP),
    managersPerDirector: z.number().int().min(0).max(MAX_MANAGERS_PER_DIRECTOR),
    icsPerManager: z.number().int().min(0).max(MAX_ICS_PER_MANAGER),
    customDirectorsPerVp: OverrideDirectorsSchema.default({}),
    customManagersPerDirector: OverrideManagersSchema.default({}),
    customIcsPerManager: OverrideIcsSchema.default({}),
  })
  .strict();
const OrganizationConfigSchema = z
  .object({
    seed: BoundedSeedSchema,
    departments: z
      .object({
        product: DepartmentOrgConfigSchema,
        engineering: DepartmentOrgConfigSchema,
        customer_success: DepartmentOrgConfigSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const counts = previewOrganizationCounts(config as OrganizationConfig);
    if (counts.totalPeople > MAX_TOTAL_PEOPLE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `organization may not generate more than ${MAX_TOTAL_PEOPLE} people`,
      });
    }
    for (const issue of validateOrganizationConfigCompatibility(config as OrganizationConfig)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `organization config is incompatible with enabled scenarios: ${issue}`,
      });
    }
  });
const OrganizationGenerateSchema = z
  .object({ seed: BoundedSeedSchema.optional(), config: OrganizationConfigSchema.optional() })
  .strict();
const DatasetGenerateSchema = z
  .object({
    seed: BoundedSeedSchema.optional(),
    datasetSize: DatasetSizeSchema.optional(),
    startTime: z.string().datetime().optional(),
  })
  .strict();
const ScenarioInstanceCreateSchema = z
  .object({
    scenarioPackId: z.string().min(1).max(128),
    scenarioInstanceId: z.string().min(1).max(160).optional(),
    seed: BoundedSeedSchema.optional(),
    datasetSize: DatasetSizeSchema.optional(),
    startTime: z.string().datetime().optional(),
    account: z.string().min(1).max(160).optional(),
    product: z.string().min(1).max(160).optional(),
    project: z.string().min(1).max(160).optional(),
    service: z.string().min(1).max(160).optional(),
    workstream: z.string().min(1).max(160).optional(),
    participantPersonIds: z
      .record(z.string().min(1).max(128), z.string().min(1).max(160))
      .optional(),
  })
  .strict();
const ClockUpdateSchema = z
  .object({
    mode: z.enum(["manual", "realtime"]).optional(),
    speedMultiplier: z
      .number()
      .positive()
      .max(24 * 60)
      .optional(),
    paused: z.boolean().optional(),
    continuousActivity: z.boolean().optional(),
    maxCatchUpSeconds: z
      .number()
      .int()
      .min(1)
      .max(60 * 60 * 24 * 7)
      .optional(),
    activityProfile: z.enum(["quiet", "standard", "intense"]).optional(),
    maxSuccessorInstancesPerReconciliation: z.number().int().min(0).max(100).optional(),
    minSuccessorIntervalHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30)
      .optional(),
  })
  .strict();

type AuthConfig = {
  adminKey: string;
  connectionCredentialToConnectionId: Map<string, string>;
  dynamicDevelopmentCredentials: boolean;
  revokedConnectionCredentials: Set<string>;
};

type ConnectionAuthResult = { ok: true; connectionId: string } | { ok: false; response: Response };

export async function createApp(options: AppOptions = {}) {
  const runtimeEnv = options.runtimeEnv ?? resolveRuntimeEnv(process.env);
  enforceProductionStorageOptions(runtimeEnv, options);
  const simulatorOptions: SimulatorOptions = {};
  if (process.env.SIMULATOR_DEFAULT_SEED)
    simulatorOptions.seed = process.env.SIMULATOR_DEFAULT_SEED;
  const configuredDatasetSize = parseDatasetSize(process.env.SIMULATOR_DEFAULT_DATASET_SIZE);
  if (configuredDatasetSize) simulatorOptions.datasetSize = configuredDatasetSize;
  if (process.env.SIMULATOR_PUBLIC_BASE_URL)
    simulatorOptions.baseUrl = process.env.SIMULATOR_PUBLIC_BASE_URL;
  const clockMode = parseClockMode(process.env.SIMULATOR_CLOCK_MODE);
  if (clockMode) simulatorOptions.clockMode = clockMode;
  const clockSpeed = parsePositiveNumber(process.env.SIMULATOR_CLOCK_SPEED);
  if (clockSpeed !== undefined) simulatorOptions.clockSpeedMultiplier = clockSpeed;
  const maxCatchUpSeconds = parsePositiveInteger(process.env.SIMULATOR_MAX_CATCH_UP_SECONDS);
  if (maxCatchUpSeconds !== undefined) simulatorOptions.maxCatchUpSeconds = maxCatchUpSeconds;
  const continuousActivity = parseBoolean(process.env.SIMULATOR_CONTINUOUS_ACTIVITY);
  if (continuousActivity !== undefined) simulatorOptions.continuousActivity = continuousActivity;
  if (options.storage) simulatorOptions.storage = options.storage;
  if (!options.simulator && !options.storage)
    simulatorOptions.storage = createStorageForRuntime(runtimeEnv);
  const feedReconciliationMaxCatchUpSeconds =
    options.feedReconciliationMaxCatchUpSeconds ??
    parsePositiveInteger(process.env.SIMULATOR_FEED_MAX_CATCH_UP_SECONDS) ??
    DEFAULT_FEED_RECONCILIATION_MAX_CATCH_UP_SECONDS;

  const simulator = options.simulator ?? (await SourceSimulator.create(simulatorOptions));
  enforceProductionSimulatorStorage(runtimeEnv, simulator);
  const auth = buildAuthConfig(simulator, options, runtimeEnv);
  const telemetry = new OperationalTelemetry(
    process.env.SIMULATOR_STRUCTURED_LOGS === "true" || isProductionLike(runtimeEnv),
  );
  const rateLimiter = new RateLimiter(
    buildRateLimitConfig(runtimeEnv, options.rateLimitConfigJson),
    (input) => simulator.checkDistributedRateLimit(input),
  );
  const failureController = new FailureController();
  failureController.setConfig(parseFailureConfig(process.env.SIMULATOR_FAILURE_MODES));
  const requestIds = new WeakMap<Request, string>();
  const app = new Hono();

  app.onError((error, c) => {
    const correlationId = requestIds.get(c.req.raw) ?? "unknown";
    if (error instanceof HttpError) {
      return jsonError(error.status, {
        ...error.details,
        error: error.message,
        classification: error.classification,
        correlationId,
      });
    }
    if (error instanceof WorldConflictError) {
      return jsonError(409, {
        error: error.message,
        classification: "world_conflict",
        correlationId,
      });
    }
    if (error instanceof StorageError) {
      return jsonError(503, {
        error: error.message,
        classification: "storage_error",
        correlationId,
      });
    }
    return jsonError(500, {
      error: "Internal simulator error",
      classification: "internal_error",
      correlationId,
    });
  });

  app.use("*", async (c, next) => {
    const requestId = telemetry.nextRequestId();
    requestIds.set(c.req.raw, requestId);
    c.header("x-request-id", requestId);
    const started = Date.now();
    let thrown: unknown;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const cursor = readCursorTelemetry(c.req.query("cursor"));
      const status = thrown instanceof HttpError ? thrown.status : thrown ? 500 : c.res.status;
      const telemetryInput: RequestTelemetryInput = {
        requestId,
        method: c.req.method,
        path: c.req.path,
        operation: operationFromPath(c.req.method, c.req.path),
        status,
        durationMs: Date.now() - started,
      };
      const connectionId = connectionIdFromPath(c.req.path);
      const worldRevision = await safeWorldRevision(simulator);
      const responseClassification =
        c.res.headers.get("x-simulator-error-classification") ?? undefined;
      const errorClassification = thrown
        ? thrown instanceof HttpError
          ? thrown.classification
          : thrown instanceof StorageError
            ? "storage_error"
            : thrown instanceof WorldConflictError
              ? "world_conflict"
              : "internal_error"
        : responseClassification;
      if (connectionId) telemetryInput.connectionId = connectionId;
      if (worldRevision) telemetryInput.worldRevision = worldRevision;
      if (cursor?.version !== undefined) telemetryInput.cursorVersion = cursor.version;
      if (cursor?.afterSequence !== undefined) telemetryInput.cursorPosition = cursor.afterSequence;
      if (errorClassification) telemetryInput.errorClassification = errorClassification;
      telemetry.recordRequest(telemetryInput);
    }
  });

  app.get("/", (c) => c.redirect("/console"));
  app.get("/healthz", (c) => c.json(buildLiveness(telemetry)));
  app.get("/readyz", async (c) => {
    const readiness = await buildReadiness(
      simulator,
      telemetry,
      requestIds.get(c.req.raw) ?? "unknown",
    );
    return c.json(readiness.body, readiness.status);
  });
  app.get("/console", (c) => c.html(consoleHtml));

  app.get("/v1/catalog", (c) => c.json(simulator.publicCatalog()));
  app.get("/v1/catalog/sources", (c) => c.json({ sources: sourceSystems }));
  app.get("/v1/catalog/scenarios", (c) =>
    c.json({
      scenarios: scenarios.map(({ events, participantRoleTemplateIds, ...scenario }) => ({
        ...scenario,
        eventCount: events.length,
        participantRoleTemplateCount: participantRoleTemplateIds.length,
      })),
    }),
  );
  app.get("/v1/catalog/scenario-packs", (c) =>
    c.json({ scenarioPacks: simulator.scenarioPacks() }),
  );
  app.get("/v1/catalog/scenario-instances", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, async () =>
      c.json({ scenarioInstances: await simulator.scenarioInstances() }),
    ),
  );
  app.get("/v1/catalog/seats", (c) => c.json({ roleTemplates }));
  app.get("/v1/catalog/people", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json({ people: simulator.people() }),
    ),
  );
  app.get("/v1/catalog/people/:personId", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json(simulator.person(c.req.param("personId"))),
    ),
  );
  app.get("/v1/catalog/organization", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json(simulator.organizationSummary()),
    ),
  );
  app.get("/v1/catalog/organization/tree", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json(simulator.organizationTree()),
    ),
  );
  app.get("/v1/catalog/teams", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json({ teams: simulator.teams() }),
    ),
  );
  app.get("/v1/catalog/teams/:teamId", (c) =>
    withAdmin(c, auth, rateLimiter, requestIds, simulator, () =>
      c.json(simulator.team(c.req.param("teamId"))),
    ),
  );

  app.get("/v1/connections/:connectionId/manifest", async (c) => {
    const authenticated = await authenticateConnection(
      c,
      auth,
      simulator,
      requestIds,
      c.req.param("connectionId"),
    );
    if (!authenticated.ok) return authenticated.response;
    const rateLimited = await rateLimitConnection(
      c,
      rateLimiter,
      requestIds,
      authenticated.connectionId,
    );
    if (rateLimited) return rateLimited;
    const failure = await failureResponse(
      c,
      failureController.evaluate({
        operation: "manifest",
        connectionId: authenticated.connectionId,
      }),
      requestIds,
    );
    if (failure) return failure;
    return c.json(simulator.manifest(authenticated.connectionId));
  });

  app.get("/v1/connections/:connectionId/records", async (c) => {
    const authenticated = await authenticateConnection(
      c,
      auth,
      simulator,
      requestIds,
      c.req.param("connectionId"),
    );
    if (!authenticated.ok) return authenticated.response;
    const rateLimited = await rateLimitConnection(
      c,
      rateLimiter,
      requestIds,
      authenticated.connectionId,
    );
    if (rateLimited) return rateLimited;
    const pagination = parseSchema(PaginationSchema, {
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
    });
    recordReconciliationTelemetry(
      telemetry,
      await simulator.reconcileSimulationClock({
        trigger: "feed",
        maxCatchUpSeconds: feedReconciliationMaxCatchUpSeconds,
      }),
    );
    const decision = failureController.evaluate({
      operation: "feed",
      connectionId: authenticated.connectionId,
    });
    const failure = await failureResponse(c, decision, requestIds);
    if (failure) return failure;
    const boundedLimit = decision.pageSize
      ? Math.min(pagination.limit ?? MAX_PAGE_SIZE, decision.pageSize)
      : pagination.limit;
    return c.json(
      applyFeedFailure(
        await simulator.feed(authenticated.connectionId, pagination.cursor, boundedLimit),
        decision,
      ),
    );
  });

  app.get("/sim/:sourceSystem/:sourceId", async (c) => {
    const authenticated = await authenticateConnection(c, auth, simulator, requestIds);
    if (!authenticated.ok) return authenticated.response;
    const rateLimited = await rateLimitConnection(
      c,
      rateLimiter,
      requestIds,
      authenticated.connectionId,
    );
    if (rateLimited) return rateLimited;
    const failure = await failureResponse(
      c,
      failureController.evaluate({
        operation: "deep_link",
        connectionId: authenticated.connectionId,
        sourceSystem: c.req.param("sourceSystem"),
      }),
      requestIds,
    );
    if (failure) return failure;
    const record = await simulator.findRecordForConnection(
      authenticated.connectionId,
      c.req.param("sourceSystem"),
      c.req.param("sourceId"),
    );
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(record.title)}</title></head><body><main><h1>${escapeHtml(record.title)}</h1><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></main></body></html>`,
      );
    }
    return c.json({ record });
  });

  app.get("/api/cron/tick", async (c) => {
    const cronAuth = authenticateCron(c, requestIds);
    if (cronAuth) return cronAuth;
    const rateLimited = await rateLimitCron(c, rateLimiter, requestIds);
    if (rateLimited) return rateLimited;
    const report = await simulator.reconcileSimulationClock({ trigger: "cron" });
    recordReconciliationTelemetry(telemetry, report);
    return c.json({ schemaVersion: "simulation-cron-tick.v1", report });
  });

  app.use("/v1/admin/*", async (c, next) => {
    const response = authenticateAdmin(c, auth, requestIds);
    if (response) return response;
    await simulator.refreshOrganizationFromStorage();
    const rateLimited = await rateLimitAdmin(c, rateLimiter, requestIds);
    if (rateLimited) return rateLimited;
    await next();
  });

  app.post("/v1/admin/scenarios/:scenarioId/reset", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ScenarioResetSchema),
    ) as ScenarioResetInput;
    return c.json(await simulator.resetScenario(c.req.param("scenarioId"), body));
  });
  app.post("/v1/admin/scenarios/:scenarioId/advance", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ScenarioAdvanceSchema),
    ) as ScenarioAdvanceInput;
    return c.json(await simulator.advanceScenario(c.req.param("scenarioId"), body));
  });
  app.post("/v1/admin/scenarios/:scenarioId/trigger", async (c) => {
    const body = await readJsonBody(c.req.raw, TriggerSchema);
    return c.json(await simulator.triggerScenarioEvent(c.req.param("scenarioId"), body.eventId));
  });
  app.post("/v1/admin/scenarios/:scenarioId/pause", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.pauseScenario(c.req.param("scenarioId")));
  });
  app.post("/v1/admin/scenarios/:scenarioId/resume", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.resumeScenario(c.req.param("scenarioId")));
  });
  app.get("/v1/admin/scenarios/:scenarioId/state", async (c) =>
    c.json(await simulator.state(c.req.param("scenarioId"))),
  );
  app.get("/v1/admin/scenarios/:scenarioId/events", async (c) =>
    c.json({ events: await simulator.eventLog(c.req.param("scenarioId")) }),
  );
  app.get("/v1/admin/records", async (c) => c.json({ records: await simulator.allRecords() }));
  app.get("/v1/admin/connections", (c) => c.json({ connections: simulator.connectionsForAdmin() }));
  app.post("/v1/admin/scenario-instances", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ScenarioInstanceCreateSchema),
    ) as unknown as ScenarioInstanceCreateInput;
    return c.json(await simulator.createScenarioInstance(body));
  });
  app.post("/v1/admin/scenario-instances/:instanceId/reset", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ScenarioResetSchema),
    ) as ScenarioResetInput;
    return c.json(await simulator.resetScenarioInstance(c.req.param("instanceId"), body));
  });
  app.post("/v1/admin/scenario-instances/:instanceId/advance", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ScenarioAdvanceSchema),
    ) as ScenarioAdvanceInput;
    return c.json(await simulator.advanceScenarioInstance(c.req.param("instanceId"), body));
  });
  app.post("/v1/admin/scenario-instances/:instanceId/trigger", async (c) => {
    const body = await readJsonBody(c.req.raw, TriggerSchema);
    return c.json(
      await simulator.triggerScenarioInstanceEvent(c.req.param("instanceId"), body.eventId),
    );
  });
  app.post("/v1/admin/scenario-instances/:instanceId/pause", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.pauseScenarioInstance(c.req.param("instanceId")));
  });
  app.post("/v1/admin/scenario-instances/:instanceId/resume", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.resumeScenarioInstance(c.req.param("instanceId")));
  });
  app.get("/v1/admin/scenario-instances/:instanceId", async (c) =>
    c.json(await simulator.scenarioInstance(c.req.param("instanceId"))),
  );
  app.delete("/v1/admin/scenario-instances/:instanceId", async (c) =>
    c.json(await simulator.deleteScenarioInstance(c.req.param("instanceId"))),
  );
  app.get("/v1/admin/scenario-instances/:instanceId/events", async (c) =>
    c.json({ events: (await simulator.scenarioInstance(c.req.param("instanceId"))).events }),
  );
  app.get("/v1/admin/scenario-instances/:instanceId/changes", async (c) =>
    c.json({ changes: (await simulator.scenarioInstance(c.req.param("instanceId"))).changes }),
  );
  app.get("/v1/admin/snapshots", async (c) =>
    c.json({ snapshots: await simulator.listSnapshots() }),
  );
  app.post("/v1/admin/snapshots", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.createSnapshot());
  });
  app.post("/v1/admin/snapshots/:snapshotId/restore", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    const params = parseSchema(SnapshotParamsSchema, { snapshotId: c.req.param("snapshotId") });
    return c.json(await simulator.restoreSnapshot(params.snapshotId));
  });
  app.post("/v1/admin/organization/generate", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, OrganizationGenerateSchema),
    ) as OrganizationGenerateInput;
    return c.json(await simulator.regenerateOrganization(body));
  });
  app.post("/v1/admin/organization/reset", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.resetOrganization());
  });
  app.get("/v1/admin/organization/relationships", (c) =>
    c.json(simulator.organizationRelationships()),
  );
  app.get("/v1/admin/organization/preview", (c) => c.json(simulator.previewOrganization()));
  app.get("/v1/admin/organization/config", (c) => c.json(simulator.getOrganizationConfig()));
  app.put("/v1/admin/organization/config", async (c) =>
    c.json(
      await simulator.putOrganizationConfig(
        (await readJsonBody(c.req.raw, OrganizationConfigSchema)) as OrganizationConfig,
      ),
    ),
  );
  app.get("/v1/admin/people/:personId/records", async (c) =>
    c.json(await simulator.recordsForPerson(c.req.param("personId"))),
  );
  app.get("/v1/admin/people/:personId/compare/:otherPersonId", async (c) =>
    c.json(
      await simulator.comparePersonVisibility(
        c.req.param("personId"),
        c.req.param("otherPersonId"),
      ),
    ),
  );
  app.get("/v1/admin/source-objects", async (c) =>
    c.json({ sourceObjects: await simulator.sourceObjects() }),
  );
  app.get("/v1/admin/source-objects/:sourceSystem/:sourceId", async (c) =>
    c.json({
      sourceObject: await simulator.sourceObject(
        c.req.param("sourceSystem"),
        c.req.param("sourceId"),
      ),
    }),
  );
  app.get("/v1/admin/source-objects/:sourceSystem/:sourceId/history", async (c) =>
    c.json({
      history: await simulator.sourceObjectHistory(
        c.req.param("sourceSystem"),
        c.req.param("sourceId"),
      ),
    }),
  );
  app.get("/v1/admin/source-changes", async (c) =>
    c.json({ sourceChanges: await simulator.sourceChanges() }),
  );
  app.get("/v1/admin/exports/workforce-one-snapshot", async (c) =>
    c.json(await simulator.workforceOneSnapshot()),
  );
  app.get("/v1/admin/clock", async (c) => c.json(await simulator.clockStatus()));
  app.put("/v1/admin/clock", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, ClockUpdateSchema),
    ) as ClockUpdateInput;
    return c.json(await simulator.updateClock(body));
  });
  app.post("/v1/admin/clock/reconcile", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    const report = await simulator.reconcileSimulationClock({ trigger: "manual" });
    recordReconciliationTelemetry(telemetry, report);
    return c.json(report);
  });
  app.post("/v1/admin/clock/pause", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.pauseClock());
  });
  app.post("/v1/admin/clock/resume", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.resumeClock());
  });
  app.get("/v1/admin/metrics", async (c) =>
    c.json(await buildMetrics(simulator, telemetry, failureController, rateLimiter)),
  );
  app.get("/v1/admin/requests", (c) => c.json({ requests: telemetry.snapshot().requests.recent }));
  app.get("/v1/admin/storage", async (c) => c.json(await buildStorageInspector(simulator)));
  app.get("/v1/admin/failure-modes", (c) => c.json(failureController.getConfig()));
  app.put("/v1/admin/failure-modes", async (c) =>
    c.json(failureController.setConfig(await readJsonBody(c.req.raw, FailureModeConfigSchema))),
  );
  app.post("/v1/admin/failure-modes/reset", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(failureController.reset());
  });
  app.post("/v1/admin/performance/benchmark", async (c) => {
    const body = await readJsonBody(c.req.raw, BenchmarkRequestSchema);
    return c.json(
      await runPerformanceBenchmark(body, {
        ...(process.env.DATABASE_URL ? { applicationDatabaseUrl: process.env.DATABASE_URL } : {}),
        ...(process.env.SIMULATOR_BENCHMARK_DATABASE_URL
          ? { benchmarkDatabaseUrl: process.env.SIMULATOR_BENCHMARK_DATABASE_URL }
          : {}),
        runtimeEnv,
      }),
    );
  });
  app.post("/v1/admin/connector-test-kit/run", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await runConnectorTestKit());
  });
  app.post("/v1/admin/datasets/generate", async (c) => {
    const body = compactOptional(
      await readJsonBody(c.req.raw, DatasetGenerateSchema),
    ) as DatasetGenerateInput;
    return c.json(await simulator.generateDataset(body));
  });
  app.get("/v1/admin/datasets/current", async (c) => c.json(await simulator.datasetMetadata()));
  app.post("/v1/admin/datasets/reset", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(await simulator.resetDataset());
  });

  (app as Hono & { close?: () => Promise<void> }).close = () => simulator.close();
  return app;
}

function buildLiveness(telemetry: OperationalTelemetry) {
  return {
    ok: true,
    schemaVersion: "simulator-liveness.v1",
    uptimeMs: telemetry.snapshot().uptimeMs,
    build: {
      version: process.env.npm_package_version ?? "0.1.0",
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
    },
    contractVersion: "source-feed.v1",
  };
}

async function buildReadiness(
  simulator: SourceSimulator,
  telemetry: OperationalTelemetry,
  correlationId: string,
): Promise<{ status: 200 | 503; body: Record<string, unknown> }> {
  const storage = await simulator.storageHealth();
  try {
    if (!storage.ok) {
      return {
        status: 503,
        body: {
          ok: false,
          schemaVersion: "simulator-readiness.v1",
          uptimeMs: telemetry.snapshot().uptimeMs,
          storage,
          classification: "storage_error",
          correlationId,
        },
      };
    }
    const metadata = await simulator.datasetMetadata();
    const organization = simulator.organizationSummary();
    const clockStatus = await simulator.clockStatus();
    return {
      status: 200,
      body: {
        ok: true,
        schemaVersion: "simulator-readiness.v1",
        uptimeMs: telemetry.snapshot().uptimeMs,
        build: {
          version: process.env.npm_package_version ?? "0.1.0",
          commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
        },
        contractVersion: "source-feed.v1",
        schemaVersionStorage: "simulator-storage.v1",
        storage,
        worldRevision: metadata.worldRevision,
        clock: {
          available: true,
          schemaVersion: clockStatus.clock.schemaVersion,
          mode: clockStatus.clock.mode,
          paused: clockStatus.clock.paused,
          lastReconciledWallTime: clockStatus.clock.lastReconciledWallTime,
          lastReconciliationStatus: clockStatus.clock.lastReconciliationReport
            ? "available"
            : "not_reconciled",
        },
        datasetMetadata: metadata,
        organization: {
          seed: organization.seed,
          counts: organization.counts,
          validationOk: organization.validation.ok,
        },
      },
    };
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        schemaVersion: "simulator-readiness.v1",
        uptimeMs: telemetry.snapshot().uptimeMs,
        storage,
        classification: "storage_error",
        correlationId,
      },
    };
  }
}

async function buildMetrics(
  simulator: SourceSimulator,
  telemetry: OperationalTelemetry,
  failureController: FailureController,
  rateLimiter: RateLimiter,
) {
  const snapshot = telemetry.snapshot();
  const metadata = await simulator.datasetMetadata();
  const states = await simulator.states();
  const sourceChanges = await simulator.sourceChanges();
  const clockStatus = await simulator.clockStatus();
  return {
    ...snapshot,
    simulator: {
      activeScenarioInstances: states.filter((state) => state.completionState === "active").length,
      scenarioInstances: metadata.scenarioInstanceCount,
      sourceChanges: metadata.totalSourceChanges,
      sourceObjects: metadata.totalSourceObjects,
      datasetSize: metadata.datasetSize,
      organizationSize: simulator.organizationSummary().counts.totalPeople,
      ledgerSize: sourceChanges.length,
      worldRevision: metadata.worldRevision,
      storage: await simulator.storageHealth(),
      failureRules: failureController.getConfig().rules.filter((rule) => rule.enabled).length,
      rateLimits: rateLimiter.snapshot(),
      clock: {
        mode: clockStatus.clock.mode,
        speedMultiplier: clockStatus.clock.speedMultiplier,
        currentSimulationTime: clockStatus.clock.lastReconciledSimulationTime,
        lastReconciledWallTime: clockStatus.clock.lastReconciledWallTime,
        reconciliationCount: clockStatus.clock.reconciliationCount,
        totalSimulationTimeAdvancedMs: clockStatus.clock.totalSimulationTimeAdvancedMs,
        continuousActivity: clockStatus.clock.continuousActivity,
        lastReconciliationReport: clockStatus.clock.lastReconciliationReport ?? null,
      },
    },
  };
}

async function buildStorageInspector(simulator: SourceSimulator) {
  const metadata = await simulator.datasetMetadata();
  return {
    schemaVersion: "simulator-storage-inspector.v1",
    storage: await simulator.storageHealth(),
    datasetMetadata: metadata,
    worldRevision: metadata.worldRevision,
    organization: {
      seed: simulator.organizationSummary().seed,
      counts: simulator.organizationSummary().counts,
      validationOk: simulator.organizationSummary().validation.ok,
    },
    clock: (await simulator.clockStatus()).clock,
    counts: {
      scenarioInstances: (await simulator.states()).length,
      snapshots: (await simulator.listSnapshots()).length,
      sourceChanges: (await simulator.sourceChanges()).length,
      sourceObjects: (await simulator.sourceObjects()).length,
    },
  };
}

async function failureResponse(
  c: Context,
  decision: FailureDecision,
  requestIds: WeakMap<Request, string>,
): Promise<Response | null> {
  if (decision.latencyMs) await sleep(decision.latencyMs);
  if (!decision.errorStatus) return null;
  return jsonError(decision.errorStatus, {
    error: decision.message ?? "Simulated provider failure",
    classification: decision.errorClassification ?? "simulated_failure",
    correlationId: requestIds.get(c.req.raw) ?? "unknown",
  });
}

function jsonError(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  const classification = typeof body.classification === "string" ? body.classification : "error";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-simulator-error-classification": classification,
      ...headers,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function operationFromPath(method: string, path: string): string {
  if (path.includes("/records")) return "feed";
  if (path.includes("/manifest")) return "manifest";
  if (path.startsWith("/sim/")) return "deep_link";
  if (path.includes("/failure-modes")) return "failure_modes";
  if (path.includes("/performance/benchmark")) return "benchmark";
  if (path.includes("/connector-test-kit")) return "connector_test_kit";
  if (path.includes("/clock")) return "clock";
  if (path.includes("/api/cron/tick")) return "cron_tick";
  if (path.includes("/metrics")) return "metrics";
  if (path.includes("/healthz")) return "health";
  if (path.includes("/snapshots")) return "snapshot";
  if (path.includes("/organization")) return "organization";
  if (path.includes("/scenario-instances")) return "scenario_instance";
  return `${method.toLowerCase()} ${path.split("/").slice(0, 4).join("/") || "/"}`;
}

function connectionIdFromPath(path: string): string | undefined {
  return /^\/v1\/connections\/([^/]+)/.exec(path)?.[1];
}

function readCursorTelemetry(
  cursor: string | undefined,
): { version?: number; afterSequence?: number } | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const telemetry: { version?: number; afterSequence?: number } = {};
    if (typeof parsed.v === "number") telemetry.version = parsed.v;
    if (typeof parsed.afterSequence === "number") telemetry.afterSequence = parsed.afterSequence;
    return telemetry;
  } catch {
    return undefined;
  }
}

async function safeWorldRevision(simulator: SourceSimulator): Promise<string | undefined> {
  try {
    return (await simulator.datasetMetadata()).worldRevision;
  } catch {
    return undefined;
  }
}

async function readJsonBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES)
    throw badRequest("Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
    throw badRequest("Request body is too large");
  if (!text.trim()) return parseSchema(schema, {});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Malformed JSON");
  }
  return parseSchema(schema, parsed);
}

function parseSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  return parsed.data;
}

function compactOptional(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function withAdmin(
  c: Context,
  auth: AuthConfig,
  rateLimiter: RateLimiter,
  requestIds: WeakMap<Request, string>,
  simulator: SourceSimulator,
  handler: () => Response | Promise<Response>,
): Promise<Response> {
  const response = authenticateAdmin(c, auth, requestIds);
  if (response) return response;
  await simulator.refreshOrganizationFromStorage();
  const rateLimited = await rateLimitAdmin(c, rateLimiter, requestIds);
  if (rateLimited) return rateLimited;
  return handler();
}

function authenticateAdmin(
  c: Context,
  auth: AuthConfig,
  requestIds: WeakMap<Request, string>,
): Response | null {
  return hasSecret(c.req.header(), auth.adminKey, "x-admin-api-key")
    ? null
    : jsonError(401, {
        error: "Unauthorized",
        classification: "authentication_error",
        correlationId: requestIds.get(c.req.raw) ?? "unknown",
      });
}

function authenticateCron(c: Context, requestIds: WeakMap<Request, string>): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected?.trim()) {
    return jsonError(503, {
      error: "Cron secret is not configured",
      classification: "configuration_error",
      correlationId: requestIds.get(c.req.raw) ?? "unknown",
    });
  }
  const authorization = c.req.header("authorization") ?? c.req.header("Authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!supplied || !constantTimeEqual(supplied, expected)) {
    return jsonError(401, {
      error: "Unauthorized",
      classification: "authentication_error",
      correlationId: requestIds.get(c.req.raw) ?? "unknown",
    });
  }
  return null;
}

async function authenticateConnection(
  c: Context,
  auth: AuthConfig,
  simulator: SourceSimulator,
  requestIds: WeakMap<Request, string>,
  requestedConnectionId?: string,
): Promise<ConnectionAuthResult> {
  await simulator.refreshOrganizationFromStorage();
  const credential = extractSecret(c.req.header(), "x-connection-secret");
  if (!credential || auth.revokedConnectionCredentials.has(credential))
    return authFailure(c, requestIds, 401, "Unauthorized");
  let authenticatedConnectionId = auth.connectionCredentialToConnectionId.get(credential);
  if (
    !authenticatedConnectionId &&
    auth.dynamicDevelopmentCredentials &&
    credential.startsWith(`${DEV_CONNECTION_PREFIX}:`)
  ) {
    authenticatedConnectionId = credential.slice(`${DEV_CONNECTION_PREFIX}:`.length);
  }
  if (!authenticatedConnectionId) return authFailure(c, requestIds, 401, "Unauthorized");
  if (!simulator.hasConnection(authenticatedConnectionId))
    return authFailure(c, requestIds, 401, "Unauthorized");
  if (requestedConnectionId && requestedConnectionId !== authenticatedConnectionId)
    return authFailure(c, requestIds, 403, "Forbidden");
  return { ok: true, connectionId: authenticatedConnectionId };
}

function authFailure(
  c: Context,
  requestIds: WeakMap<Request, string>,
  status: 401 | 403,
  message: string,
): ConnectionAuthResult {
  return {
    ok: false,
    response: jsonError(status, {
      error: message,
      classification: status === 401 ? "authentication_error" : "authorization_error",
      correlationId: requestIds.get(c.req.raw) ?? "unknown",
    }),
  };
}

async function rateLimitAdmin(
  c: Context,
  rateLimiter: RateLimiter,
  requestIds: WeakMap<Request, string>,
): Promise<Response | null> {
  return rateLimitResponse(c, await rateLimiter.check("admin", "admin"), requestIds);
}

async function rateLimitConnection(
  c: Context,
  rateLimiter: RateLimiter,
  requestIds: WeakMap<Request, string>,
  connectionId: string,
): Promise<Response | null> {
  return rateLimitResponse(c, await rateLimiter.check("connection", connectionId), requestIds);
}

async function rateLimitCron(
  c: Context,
  rateLimiter: RateLimiter,
  requestIds: WeakMap<Request, string>,
): Promise<Response | null> {
  return rateLimitResponse(c, await rateLimiter.check("cron", "cron"), requestIds);
}

function rateLimitResponse(
  c: Context,
  decision: { allowed: boolean; retryAfterSeconds?: number },
  requestIds: WeakMap<Request, string>,
): Response | null {
  if (decision.allowed) return null;
  return jsonError(
    429,
    {
      error: "Rate limit exceeded",
      classification: "rate_limit",
      correlationId: requestIds.get(c.req.raw) ?? "unknown",
    },
    { "Retry-After": String(decision.retryAfterSeconds ?? 1) },
  );
}

function hasSecret(
  headers: Record<string, string | undefined>,
  expected: string,
  headerName: string,
): boolean {
  return extractSecret(headers, headerName) === expected;
}

function extractSecret(
  headers: Record<string, string | undefined>,
  headerName: string,
): string | undefined {
  const headerSecret = headers[headerName] ?? headers[headerName.toLowerCase()];
  const auth = headers.authorization ?? headers.Authorization;
  const bearerSecret = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return headerSecret ?? bearerSecret;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function recordReconciliationTelemetry(
  telemetry: OperationalTelemetry,
  report: {
    trigger: string;
    simulationDeltaMs: number;
    instancesCreated: number;
    changesAppended: number;
    alreadyCurrent: boolean;
  },
): void {
  telemetry.increment("reconciliation.count");
  telemetry.increment(`reconciliation.trigger.${report.trigger}`);
  if (report.alreadyCurrent) telemetry.increment("reconciliation.already_current");
  telemetry.increment("reconciliation.simulation_time_advanced_ms", report.simulationDeltaMs);
  telemetry.increment("reconciliation.successor_instances_created", report.instancesCreated);
  telemetry.increment("reconciliation.source_changes_appended", report.changesAppended);
}

function buildAuthConfig(
  simulator: SourceSimulator,
  options: AppOptions,
  runtimeEnv: RuntimeEnv,
): AuthConfig {
  const productionLike = isProductionLike(runtimeEnv);
  const adminKey =
    options.adminKey ??
    process.env.SIMULATOR_ADMIN_API_KEY ??
    (productionLike ? undefined : DEV_ADMIN_KEY);
  if (!adminKey) throw new Error("SIMULATOR_ADMIN_API_KEY is required outside local development");

  const configuredCredentials =
    options.connectionCredentials ??
    parseConnectionCredentials(process.env.SIMULATOR_CONNECTION_CREDENTIALS);
  const dynamicDevelopmentCredentials = !configuredCredentials && !productionLike;
  const connectionCredentials = configuredCredentials ?? {};
  if (!dynamicDevelopmentCredentials && Object.keys(connectionCredentials).length === 0) {
    throw new Error("Connection-bound credentials are required outside local development");
  }

  const revokedConnectionCredentials = new Set([
    ...parseCsv(process.env.SIMULATOR_REVOKED_CONNECTION_CREDENTIALS),
    ...(options.revokedConnectionCredentials ?? []),
  ]);
  validateAuthConfig({
    adminKey,
    connectionCredentials,
    revokedConnectionCredentials,
    simulator,
    productionLike,
  });
  return {
    adminKey,
    connectionCredentialToConnectionId: new Map(Object.entries(connectionCredentials)),
    dynamicDevelopmentCredentials,
    revokedConnectionCredentials,
  };
}

function validateAuthConfig(input: {
  adminKey: string;
  connectionCredentials: Record<string, string>;
  revokedConnectionCredentials: Set<string>;
  simulator: SourceSimulator;
  productionLike: boolean;
}): void {
  const validConnectionIds = new Set(input.simulator.connectionIds());
  for (const [credential, connectionId] of Object.entries(input.connectionCredentials)) {
    if (!credential.trim()) throw new Error("Connection credential keys must be non-empty");
    if (!validConnectionIds.has(connectionId))
      throw new Error(`Connection credential references unknown connection ${connectionId}`);
    if (credential === input.adminKey)
      throw new Error("Admin and connection credentials must be different");
    if (input.productionLike && isKnownDevelopmentConnectionCredential(credential)) {
      throw new Error(
        "Known development connection credentials are rejected outside local development",
      );
    }
  }
  if (input.productionLike && input.adminKey === DEV_ADMIN_KEY) {
    throw new Error("Known development admin credential is rejected outside local development");
  }
}

function parseConnectionCredentials(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  const schema = z.record(z.string().min(1), z.string().min(1));
  return schema.parse(parsed);
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isKnownDevelopmentConnectionCredential(value: string): boolean {
  return value === DEV_CONNECTION_PREFIX || value.startsWith(`${DEV_CONNECTION_PREFIX}:`);
}

function enforceProductionStorageOptions(runtimeEnv: RuntimeEnv, options: AppOptions): void {
  if (!isProductionLike(runtimeEnv)) return;
  if (options.storage) {
    rejectProductionStorageKind(options.storage.kind, "Injected storage");
  }
  if (options.simulator) {
    rejectProductionStorageKind(options.simulator.storageKind(), "Injected simulator storage");
  }
}

function enforceProductionSimulatorStorage(
  runtimeEnv: RuntimeEnv,
  simulator: SourceSimulator,
): void {
  if (!isProductionLike(runtimeEnv)) return;
  rejectProductionStorageKind(simulator.storageKind(), "Simulator storage");
}

function rejectProductionStorageKind(kind: SimulatorStorage["kind"], label: string): void {
  if (kind === "memory")
    throw new Error(
      `${label} uses memory storage, which is forbidden in production-like environments`,
    );
  if (kind === "sqlite")
    throw new Error(
      `${label} uses SQLite storage, which is forbidden in production-like environments`,
    );
  if (kind !== "postgres")
    throw new Error(
      `${label} uses unknown storage, which is forbidden in production-like environments`,
    );
}

function createStorageForRuntime(runtimeEnv: RuntimeEnv): SimulatorStorage {
  const productionLike = isProductionLike(runtimeEnv);
  const driver = process.env.SIMULATOR_STORAGE_DRIVER;
  const databaseUrl = process.env.DATABASE_URL;
  if (driver === "memory") {
    if (productionLike || process.env.SIMULATOR_ALLOW_EPHEMERAL_MEMORY !== "true") {
      throw new Error(
        "In-memory storage must be explicitly selected and is forbidden in production-like environments",
      );
    }
    return new MemorySimulatorStorage();
  }
  if (driver === "sqlite" && productionLike) {
    throw new Error("SQLite storage is forbidden in production-like environments");
  }
  if (driver === "postgres") {
    if (!databaseUrl?.startsWith("postgres"))
      throw new Error("SIMULATOR_STORAGE_DRIVER=postgres requires a Postgres DATABASE_URL");
    return new PostgresSimulatorStorage(databaseUrl);
  }
  if (databaseUrl?.startsWith("postgres")) {
    return new PostgresSimulatorStorage(databaseUrl);
  }
  if (driver === "sqlite" || (!productionLike && !databaseUrl)) {
    return new SQLiteSimulatorStorage(
      process.env.SIMULATOR_SQLITE_PATH ?? ".simulator/source-simulator.sqlite",
    );
  }
  if (productionLike) {
    throw new Error("Durable Postgres storage is required in production-like environments");
  }
  return new SQLiteSimulatorStorage(
    process.env.SIMULATOR_SQLITE_PATH ?? ".simulator/source-simulator.sqlite",
  );
}

function resolveRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  if (
    env.SIMULATOR_RUNTIME_ENV === "production" ||
    env.SIMULATOR_RUNTIME_ENV === "preview" ||
    env.SIMULATOR_RUNTIME_ENV === "test"
  ) {
    return env.SIMULATOR_RUNTIME_ENV;
  }
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview" || env.VERCEL) return "preview";
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}

function isProductionLike(runtimeEnv: RuntimeEnv): boolean {
  return runtimeEnv === "production" || runtimeEnv === "preview";
}

function parseDatasetSize(value: string | undefined): DatasetSize | undefined {
  if (value === "small" || value === "medium" || value === "large") return value;
  return undefined;
}

function parseClockMode(value: string | undefined): "manual" | "realtime" | undefined {
  if (!value) return undefined;
  if (value === "manual" || value === "realtime") return value;
  throw new Error("SIMULATOR_CLOCK_MODE must be manual or realtime");
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error("Expected a positive numeric environment value");
  return parsed;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error("Expected a positive integer environment value");
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Expected boolean environment value to be true or false");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const consoleHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Source Simulator Console</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #172033; }
    main { max-width: 1180px; margin: 0 auto; }
    button, input, select { font: inherit; margin: 0.25rem; }
    pre { background: #f5f7fb; padding: 1rem; overflow: auto; border: 1px solid #d8deea; min-height: 18rem; }
    .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    .panel { border-top: 1px solid #d8deea; margin-top: 1.25rem; padding-top: 1rem; }
  </style>
</head>
<body>
  <main>
    <h1>Source Simulator Console</h1>
    <section class="panel">
      <h2>Organization</h2>
      <div class="row">
        <label>Admin key <input id="key" value="dev-admin-key" /></label>
        <label>Seed <input id="orgSeed" value="wfo-m1-org-seed" /></label>
        <label>Department <select id="department"><option value="">All</option><option>product</option><option>engineering</option><option>customer_success</option></select></label>
        <label>Level <select id="level"><option value="">All</option><option>ic</option><option>manager</option><option>director</option><option>vp</option></select></label>
        <input id="search" placeholder="Search people" />
        <button onclick="loadOrg()">Tree</button>
        <button onclick="loadPeople()">People</button>
        <button onclick="generateOrg()">Regenerate</button>
        <button onclick="resetOrg()">Reset</button>
      </div>
      <div class="row">
        <label>Person A <input id="personA" /></label>
        <label>Person B <input id="personB" /></label>
        <button onclick="personDetail()">Person Detail</button>
        <button onclick="personRecords()">Person Records</button>
        <button onclick="comparePeople()">Compare Visibility</button>
      </div>
    </section>
    <section class="panel">
      <h2>Scenario</h2>
      <div class="row">
        <label>Scenario <select id="scenario">
          <option>product-launch-readiness</option>
          <option>feature-adoption-lag</option>
          <option>roadmap-tradeoff</option>
          <option>reliability-incident</option>
          <option>migration-delivery-slip</option>
          <option>technical-debt-staffing-risk</option>
          <option>renewal-risk</option>
          <option>implementation-blocker</option>
          <option>expansion-opportunity</option>
          <option>major-cross-functional-product-release</option>
        </select></label>
        <label>Instance <input id="instance" placeholder="scenario-instance-id" /></label>
        <button onclick="callAdmin('state','GET')">State</button>
        <button onclick="callAdmin('reset','POST')">Reset</button>
        <button onclick="advance()">Advance 24h</button>
        <button onclick="callAdmin('events','GET')">Events</button>
        <button onclick="packs()">Packs</button>
        <button onclick="instances()">Instances</button>
        <button onclick="instanceDetail()">Instance Detail</button>
        <button onclick="records()">All Records</button>
      </div>
    </section>
    <section class="panel">
      <h2>Clock</h2>
      <div class="row">
        <label>Mode <select id="clockMode"><option>manual</option><option>realtime</option></select></label>
        <label>Speed <input id="clockSpeed" type="number" min="1" max="1440" value="30" /></label>
        <label>Continuous <select id="clockContinuous"><option value="true">enabled</option><option value="false">disabled</option></select></label>
        <label>Profile <select id="activityProfile"><option>standard</option><option>quiet</option><option>intense</option></select></label>
        <label>Max successors <input id="maxSuccessors" type="number" min="0" max="100" value="6" /></label>
        <label>Min interval h <input id="minSuccessorInterval" type="number" min="0" max="720" value="12" /></label>
        <button onclick="clockStatus()">Clock Status</button>
        <button onclick="updateClock()">Apply Clock</button>
        <button onclick="pauseClock()">Pause</button>
        <button onclick="resumeClock()">Resume</button>
        <button onclick="reconcileClock()">Reconcile Now</button>
      </div>
    </section>
    <section class="panel">
      <h2>Operations</h2>
      <div class="row">
        <button onclick="health()">Health</button>
        <button onclick="metrics()">Metrics</button>
        <button onclick="requests()">Request Inspector</button>
        <button onclick="storageInspector()">Storage Inspector</button>
        <button onclick="sourceChanges()">Ledger Inspector</button>
        <button onclick="snapshots()">Snapshot Browser</button>
        <button onclick="connectorKit()">Connector Test Kit</button>
      </div>
      <div class="row">
        <label>Failure mode <select id="failureMode">
          <option>rate_limit</option>
          <option>timeout</option>
          <option>service_unavailable</option>
          <option>internal_error</option>
          <option>network_latency</option>
          <option>partial_page</option>
          <option>cursor_corruption</option>
          <option>auth_failure</option>
          <option>expired_credentials</option>
          <option>provider_outage</option>
          <option>malformed_payload</option>
          <option>permission_changes</option>
          <option>deleted_objects</option>
          <option>edited_objects</option>
          <option>late_arriving_objects</option>
          <option>duplicate_objects</option>
          <option>stale_objects</option>
        </select></label>
        <label>Operation <input id="failureOperation" value="feed" /></label>
        <label>Connection <input id="failureConnection" value="conn-product-manager" /></label>
        <button onclick="setFailure()">Set Failure</button>
        <button onclick="failureModes()">Failure Config</button>
        <button onclick="resetFailures()">Reset Failures</button>
      </div>
      <div class="row">
        <label>Benchmark storage <select id="benchmarkStorage"><option>memory</option><option>sqlite</option><option>postgres</option></select></label>
        <label>Benchmark size <select id="benchmarkSize"><option>small</option><option>medium</option><option>large</option></select></label>
        <button onclick="benchmark()">Run Benchmark</button>
      </div>
    </section>
    <section class="panel">
      <h2>Sources And Dataset</h2>
      <div class="row">
        <label>Dataset <select id="dataset"><option>small</option><option>medium</option><option>large</option></select></label>
        <label>Dataset seed <input id="datasetSeed" value="wfo-m2-dataset-seed" /></label>
        <button onclick="datasetCurrent()">Current Dataset</button>
        <button onclick="datasetGenerate()">Generate Dataset</button>
        <button onclick="sourceObjects()">Source Objects</button>
        <button onclick="sourceChanges()">Source Changes</button>
      </div>
      <div class="row">
        <label>Source <input id="sourceSystem" placeholder="slack" /></label>
        <label>Source ID <input id="sourceId" /></label>
        <button onclick="sourceObject()">Object</button>
        <button onclick="sourceHistory()">History</button>
      </div>
    </section>
    <pre id="out">Ready.</pre>
  </main>
<script>
const out = document.getElementById('out');
function scenario() { return document.getElementById('scenario').value; }
function key() { return document.getElementById('key').value; }
function headers(extra = {}) { return { 'x-admin-api-key': key(), ...extra }; }
function show(value) { out.textContent = JSON.stringify(value, null, 2); }
async function getJson(url, opts = {}) { const res = await fetch(url, opts); return res.json(); }
async function callAdmin(action, method) { show(await getJson('/v1/admin/scenarios/' + scenario() + '/' + action, { method, headers: headers({ 'content-type': 'application/json' }), body: method === 'POST' ? '{}' : undefined })); }
async function advance() { show(await getJson('/v1/admin/scenarios/' + scenario() + '/advance', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ hours: 24 }) })); }
async function records() { show(await getJson('/v1/admin/records', { headers: headers() })); }
async function health() { show(await getJson('/healthz')); }
async function clockStatus() { show(await getJson('/v1/admin/clock', { headers: headers() })); }
async function updateClock() {
  show(await getJson('/v1/admin/clock', {
    method: 'PUT',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      mode: document.getElementById('clockMode').value,
      speedMultiplier: Number(document.getElementById('clockSpeed').value),
      continuousActivity: document.getElementById('clockContinuous').value === 'true',
      activityProfile: document.getElementById('activityProfile').value,
      maxSuccessorInstancesPerReconciliation: Number(document.getElementById('maxSuccessors').value),
      minSuccessorIntervalHours: Number(document.getElementById('minSuccessorInterval').value)
    })
  }));
}
async function pauseClock() { show(await getJson('/v1/admin/clock/pause', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function resumeClock() { show(await getJson('/v1/admin/clock/resume', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function reconcileClock() { show(await getJson('/v1/admin/clock/reconcile', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function metrics() { show(await getJson('/v1/admin/metrics', { headers: headers() })); }
async function requests() { show(await getJson('/v1/admin/requests', { headers: headers() })); }
async function storageInspector() { show(await getJson('/v1/admin/storage', { headers: headers() })); }
async function snapshots() { show(await getJson('/v1/admin/snapshots', { headers: headers() })); }
async function connectorKit() { show(await getJson('/v1/admin/connector-test-kit/run', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function benchmark() { show(await getJson('/v1/admin/performance/benchmark', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ storage: document.getElementById('benchmarkStorage').value, datasetSizes: [document.getElementById('benchmarkSize').value] }) })); }
async function failureModes() { show(await getJson('/v1/admin/failure-modes', { headers: headers() })); }
async function setFailure() {
  const mode = document.getElementById('failureMode').value;
  const operation = document.getElementById('failureOperation').value;
  const connectionId = document.getElementById('failureConnection').value;
  show(await getJson('/v1/admin/failure-modes', { method: 'PUT', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ schemaVersion: 'failure-modes.v1', rules: [{ id: 'console-' + mode, enabled: true, mode, operation, connectionId, pageSize: 1, latencyMs: 250 }] }) }));
}
async function resetFailures() { show(await getJson('/v1/admin/failure-modes/reset', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function packs() { show(await getJson('/v1/catalog/scenario-packs')); }
async function instances() { show(await getJson('/v1/catalog/scenario-instances', { headers: headers() })); }
async function instanceDetail() { show(await getJson('/v1/admin/scenario-instances/' + document.getElementById('instance').value, { headers: headers() })); }
async function datasetCurrent() { show(await getJson('/v1/admin/datasets/current', { headers: headers() })); }
async function datasetGenerate() { show(await getJson('/v1/admin/datasets/generate', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ seed: document.getElementById('datasetSeed').value, datasetSize: document.getElementById('dataset').value }) })); }
async function sourceObjects() { show(await getJson('/v1/admin/source-objects', { headers: headers() })); }
async function sourceChanges() { show(await getJson('/v1/admin/source-changes', { headers: headers() })); }
async function sourceObject() { show(await getJson('/v1/admin/source-objects/' + document.getElementById('sourceSystem').value + '/' + document.getElementById('sourceId').value, { headers: headers() })); }
async function sourceHistory() { show(await getJson('/v1/admin/source-objects/' + document.getElementById('sourceSystem').value + '/' + document.getElementById('sourceId').value + '/history', { headers: headers() })); }
async function loadOrg() { show(await getJson('/v1/catalog/organization/tree', { headers: headers() })); }
async function loadPeople() {
  const data = await getJson('/v1/catalog/people', { headers: headers() });
  const dept = document.getElementById('department').value;
  const level = document.getElementById('level').value;
  const search = document.getElementById('search').value.toLowerCase();
  show({ people: data.people.filter(p => (!dept || p.department === dept) && (!level || p.roleLevel === level) && (!search || p.name.toLowerCase().includes(search) || p.email.includes(search))) });
}
async function generateOrg() { show(await getJson('/v1/admin/organization/generate', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ seed: document.getElementById('orgSeed').value }) })); }
async function resetOrg() { show(await getJson('/v1/admin/organization/reset', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' })); }
async function personDetail() { show(await getJson('/v1/catalog/people/' + document.getElementById('personA').value, { headers: headers() })); }
async function personRecords() { show(await getJson('/v1/admin/people/' + document.getElementById('personA').value + '/records', { headers: headers() })); }
async function comparePeople() { show(await getJson('/v1/admin/people/' + document.getElementById('personA').value + '/compare/' + document.getElementById('personB').value, { headers: headers() })); }
</script>
</body>
</html>`;
