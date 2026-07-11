import { Hono, type Context } from "hono";
import { z } from "zod";
import { SourceSimulator, HttpError, badRequest, type SimulatorOptions } from "./engine.js";
import { scenarios } from "./data.js";
import { previewOrganizationCounts, roleTemplates } from "./organization.js";
import { MemorySimulatorStorage, SQLiteSimulatorStorage, type SimulatorStorage } from "./storage.js";
import { datasetSizes, sourceSystems, type DatasetSize, type OrganizationConfig } from "./domain.js";

export interface AppOptions {
  simulator?: SourceSimulator;
  adminKey?: string;
  connectionCredentials?: Record<string, string>;
  revokedConnectionCredentials?: string[];
  runtimeEnv?: RuntimeEnv;
  storage?: SimulatorStorage;
}

type RuntimeEnv = "development" | "test" | "preview" | "production";
type ScenarioResetInput = { seed?: string; datasetSize?: DatasetSize; startTime?: string };
type ScenarioAdvanceInput = { hours?: number; days?: number };
type OrganizationGenerateInput = { seed?: string; config?: OrganizationConfig };

const DEV_ADMIN_KEY = "dev-admin-key";
const DEV_CONNECTION_PREFIX = "dev-connection-secret";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_VPS = 3;
const MAX_DIRECTORS_PER_VP = 8;
const MAX_MANAGERS_PER_DIRECTOR = 10;
const MAX_ICS_PER_MANAGER = 25;
const MAX_TOTAL_PEOPLE = 500;

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
    hours: z.number().int().min(0).max(24 * 30).optional(),
    days: z.number().int().min(0).max(30).optional(),
  })
  .strict()
  .refine((input) => input.hours !== undefined || input.days !== undefined, "hours or days is required");
const TriggerSchema = z.object({ eventId: z.string().min(1).max(100) }).strict();
const EmptyBodySchema = z.object({}).strict();
const PaginationSchema = z
  .object({
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  })
  .strict();
const SnapshotParamsSchema = z.object({ snapshotId: z.string().min(1).max(128) }).strict();
const OverrideDirectorsSchema = z.record(z.string().min(1).max(96), z.number().int().min(0).max(MAX_DIRECTORS_PER_VP));
const OverrideManagersSchema = z.record(z.string().min(1).max(96), z.number().int().min(0).max(MAX_MANAGERS_PER_DIRECTOR));
const OverrideIcsSchema = z.record(z.string().min(1).max(96), z.number().int().min(0).max(MAX_ICS_PER_MANAGER));
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
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `organization may not generate more than ${MAX_TOTAL_PEOPLE} people` });
    }
  });
const OrganizationGenerateSchema = z.object({ seed: BoundedSeedSchema.optional(), config: OrganizationConfigSchema.optional() }).strict();

type AuthConfig = {
  adminKey: string;
  connectionCredentialToConnectionId: Map<string, string>;
  revokedConnectionCredentials: Set<string>;
};

type ConnectionAuthResult = { ok: true; connectionId: string } | { ok: false; response: Response };

export function createApp(options: AppOptions = {}) {
  const runtimeEnv = options.runtimeEnv ?? resolveRuntimeEnv(process.env);
  const simulatorOptions: SimulatorOptions = {};
  if (process.env.SIMULATOR_DEFAULT_SEED) simulatorOptions.seed = process.env.SIMULATOR_DEFAULT_SEED;
  const configuredDatasetSize = parseDatasetSize(process.env.SIMULATOR_DEFAULT_DATASET_SIZE);
  if (configuredDatasetSize) simulatorOptions.datasetSize = configuredDatasetSize;
  if (process.env.SIMULATOR_PUBLIC_BASE_URL) simulatorOptions.baseUrl = process.env.SIMULATOR_PUBLIC_BASE_URL;
  if (options.storage) simulatorOptions.storage = options.storage;
  if (!options.simulator && !options.storage) simulatorOptions.storage = createStorageForRuntime(runtimeEnv);

  const simulator = options.simulator ?? new SourceSimulator(simulatorOptions);
  const auth = buildAuthConfig(simulator, options, runtimeEnv);
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404);
    }
    return c.json({ error: "Internal simulator error" }, 500);
  });

  app.get("/", (c) => c.redirect("/console"));
  app.get("/healthz", (c) => c.json({ ok: true, schemaVersion: "source-feed.v1" }));
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
  app.get("/v1/catalog/seats", (c) => c.json({ roleTemplates }));
  app.get("/v1/catalog/people", (c) => withAdmin(c, auth, () => c.json({ people: simulator.people() })));
  app.get("/v1/catalog/people/:personId", (c) => withAdmin(c, auth, () => c.json(simulator.person(c.req.param("personId")))));
  app.get("/v1/catalog/organization", (c) => withAdmin(c, auth, () => c.json(simulator.organizationSummary())));
  app.get("/v1/catalog/organization/tree", (c) => withAdmin(c, auth, () => c.json(simulator.organizationTree())));
  app.get("/v1/catalog/teams", (c) => withAdmin(c, auth, () => c.json({ teams: simulator.teams() })));
  app.get("/v1/catalog/teams/:teamId", (c) => withAdmin(c, auth, () => c.json(simulator.team(c.req.param("teamId")))));

  app.get("/v1/connections/:connectionId/manifest", (c) => {
    const authenticated = authenticateConnection(c, auth, c.req.param("connectionId"));
    if (!authenticated.ok) return authenticated.response;
    return c.json(simulator.manifest(authenticated.connectionId));
  });

  app.get("/v1/connections/:connectionId/records", (c) => {
    const authenticated = authenticateConnection(c, auth, c.req.param("connectionId"));
    if (!authenticated.ok) return authenticated.response;
    const pagination = parseSchema(PaginationSchema, { cursor: c.req.query("cursor"), limit: c.req.query("limit") });
    return c.json(simulator.feed(authenticated.connectionId, pagination.cursor, pagination.limit));
  });

  app.get("/sim/:sourceSystem/:sourceId", (c) => {
    const authenticated = authenticateConnection(c, auth);
    if (!authenticated.ok) return authenticated.response;
    const record = simulator.findRecordForConnection(authenticated.connectionId, c.req.param("sourceSystem"), c.req.param("sourceId"));
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(record.title)}</title></head><body><main><h1>${escapeHtml(record.title)}</h1><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre></main></body></html>`);
    }
    return c.json({ record });
  });

  app.use("/v1/admin/*", async (c, next) => {
    const response = authenticateAdmin(c, auth);
    if (response) return response;
    await next();
  });

  app.post("/v1/admin/scenarios/:scenarioId/reset", async (c) => {
    const body = compactOptional(await readJsonBody(c.req.raw, ScenarioResetSchema)) as ScenarioResetInput;
    return c.json(simulator.resetScenario(c.req.param("scenarioId"), body));
  });
  app.post("/v1/admin/scenarios/:scenarioId/advance", async (c) => {
    const body = compactOptional(await readJsonBody(c.req.raw, ScenarioAdvanceSchema)) as ScenarioAdvanceInput;
    return c.json(simulator.advanceScenario(c.req.param("scenarioId"), body));
  });
  app.post("/v1/admin/scenarios/:scenarioId/trigger", async (c) => {
    const body = await readJsonBody(c.req.raw, TriggerSchema);
    return c.json(simulator.triggerScenarioEvent(c.req.param("scenarioId"), body.eventId));
  });
  app.post("/v1/admin/scenarios/:scenarioId/pause", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(simulator.pauseScenario(c.req.param("scenarioId")));
  });
  app.post("/v1/admin/scenarios/:scenarioId/resume", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(simulator.resumeScenario(c.req.param("scenarioId")));
  });
  app.get("/v1/admin/scenarios/:scenarioId/state", (c) => c.json(simulator.state(c.req.param("scenarioId"))));
  app.get("/v1/admin/scenarios/:scenarioId/events", (c) => c.json({ events: simulator.eventLog(c.req.param("scenarioId")) }));
  app.get("/v1/admin/records", (c) => c.json({ records: simulator.allRecords() }));
  app.get("/v1/admin/connections", (c) => c.json({ connections: simulator.connectionsForAdmin() }));
  app.get("/v1/admin/snapshots", (c) => c.json({ snapshots: simulator.listSnapshots() }));
  app.post("/v1/admin/snapshots", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(simulator.createSnapshot());
  });
  app.post("/v1/admin/snapshots/:snapshotId/restore", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    const params = parseSchema(SnapshotParamsSchema, { snapshotId: c.req.param("snapshotId") });
    return c.json(simulator.restoreSnapshot(params.snapshotId));
  });
  app.post("/v1/admin/organization/generate", async (c) => {
    const body = compactOptional(await readJsonBody(c.req.raw, OrganizationGenerateSchema)) as OrganizationGenerateInput;
    return c.json(simulator.regenerateOrganization(body));
  });
  app.post("/v1/admin/organization/reset", async (c) => {
    await readJsonBody(c.req.raw, EmptyBodySchema);
    return c.json(simulator.resetOrganization());
  });
  app.get("/v1/admin/organization/config", (c) => c.json(simulator.getOrganizationConfig()));
  app.put("/v1/admin/organization/config", async (c) =>
    c.json(simulator.putOrganizationConfig((await readJsonBody(c.req.raw, OrganizationConfigSchema)) as OrganizationConfig)),
  );
  app.get("/v1/admin/people/:personId/records", (c) => c.json(simulator.recordsForPerson(c.req.param("personId"))));
  app.get("/v1/admin/people/:personId/compare/:otherPersonId", (c) =>
    c.json(simulator.comparePersonVisibility(c.req.param("personId"), c.req.param("otherPersonId"))),
  );

  return app;
}

async function readJsonBody<TSchema extends z.ZodTypeAny>(request: Request, schema: TSchema): Promise<z.infer<TSchema>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw badRequest("Request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw badRequest("Request body is too large");
  if (!text.trim()) return parseSchema(schema, {});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Malformed JSON");
  }
  return parseSchema(schema, parsed);
}

function parseSchema<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  return parsed.data;
}

function compactOptional(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function withAdmin(c: Context, auth: AuthConfig, handler: () => Response): Response {
  const response = authenticateAdmin(c, auth);
  return response ?? handler();
}

function authenticateAdmin(c: Context, auth: AuthConfig): Response | null {
  return hasSecret(c.req.header(), auth.adminKey, "x-admin-api-key") ? null : new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function authenticateConnection(c: Context, auth: AuthConfig, requestedConnectionId?: string): ConnectionAuthResult {
  const credential = extractSecret(c.req.header(), "x-connection-secret");
  if (!credential || auth.revokedConnectionCredentials.has(credential)) return authFailure(401, "Unauthorized");
  const authenticatedConnectionId = auth.connectionCredentialToConnectionId.get(credential);
  if (!authenticatedConnectionId) return authFailure(401, "Unauthorized");
  if (requestedConnectionId && requestedConnectionId !== authenticatedConnectionId) return authFailure(403, "Forbidden");
  return { ok: true, connectionId: authenticatedConnectionId };
}

function authFailure(status: 401 | 403, message: string): ConnectionAuthResult {
  return { ok: false, response: new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json" } }) };
}

function hasSecret(headers: Record<string, string | undefined>, expected: string, headerName: string): boolean {
  return extractSecret(headers, headerName) === expected;
}

function extractSecret(headers: Record<string, string | undefined>, headerName: string): string | undefined {
  const headerSecret = headers[headerName] ?? headers[headerName.toLowerCase()];
  const auth = headers.authorization ?? headers.Authorization;
  const bearerSecret = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return headerSecret ?? bearerSecret;
}

function buildAuthConfig(simulator: SourceSimulator, options: AppOptions, runtimeEnv: RuntimeEnv): AuthConfig {
  const productionLike = isProductionLike(runtimeEnv);
  const adminKey = options.adminKey ?? process.env.SIMULATOR_ADMIN_API_KEY ?? (productionLike ? undefined : DEV_ADMIN_KEY);
  if (!adminKey) throw new Error("SIMULATOR_ADMIN_API_KEY is required outside local development");

  const configuredCredentials = options.connectionCredentials ?? parseConnectionCredentials(process.env.SIMULATOR_CONNECTION_CREDENTIALS);
  const connectionCredentials = configuredCredentials ?? (productionLike ? undefined : developmentConnectionCredentials(simulator.connectionIds()));
  if (!connectionCredentials || Object.keys(connectionCredentials).length === 0) {
    throw new Error("Connection-bound credentials are required outside local development");
  }

  const revokedConnectionCredentials = new Set([
    ...parseCsv(process.env.SIMULATOR_REVOKED_CONNECTION_CREDENTIALS),
    ...(options.revokedConnectionCredentials ?? []),
  ]);
  validateAuthConfig({ adminKey, connectionCredentials, revokedConnectionCredentials, simulator, productionLike });
  return { adminKey, connectionCredentialToConnectionId: new Map(Object.entries(connectionCredentials)), revokedConnectionCredentials };
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
    if (!validConnectionIds.has(connectionId)) throw new Error(`Connection credential references unknown connection ${connectionId}`);
    if (credential === input.adminKey) throw new Error("Admin and connection credentials must be different");
    if (input.productionLike && isKnownDevelopmentConnectionCredential(credential)) {
      throw new Error("Known development connection credentials are rejected outside local development");
    }
  }
  if (input.productionLike && input.adminKey === DEV_ADMIN_KEY) {
    throw new Error("Known development admin credential is rejected outside local development");
  }
}

function developmentConnectionCredentials(connectionIds: string[]): Record<string, string> {
  return Object.fromEntries(connectionIds.map((connectionId) => [`${DEV_CONNECTION_PREFIX}:${connectionId}`, connectionId]));
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

function createStorageForRuntime(runtimeEnv: RuntimeEnv): SimulatorStorage {
  const productionLike = isProductionLike(runtimeEnv);
  const driver = process.env.SIMULATOR_STORAGE_DRIVER;
  if (driver === "memory") {
    if (productionLike || process.env.SIMULATOR_ALLOW_EPHEMERAL_MEMORY !== "true") {
      throw new Error("In-memory storage must be explicitly selected and is forbidden in production-like environments");
    }
    return new MemorySimulatorStorage();
  }
  if (driver === "sqlite" || (!productionLike && !process.env.DATABASE_URL)) {
    return new SQLiteSimulatorStorage(process.env.SIMULATOR_SQLITE_PATH ?? ".simulator/source-simulator.sqlite");
  }
  if (process.env.DATABASE_URL?.startsWith("postgres")) {
    throw new Error("Postgres durable storage is required for this environment but the adapter is not yet proven; refusing memory fallback");
  }
  if (productionLike) {
    throw new Error("Durable storage is required in production-like environments");
  }
  return new SQLiteSimulatorStorage(process.env.SIMULATOR_SQLITE_PATH ?? ".simulator/source-simulator.sqlite");
}

function resolveRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  if (env.SIMULATOR_RUNTIME_ENV === "production" || env.SIMULATOR_RUNTIME_ENV === "preview" || env.SIMULATOR_RUNTIME_ENV === "test") {
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
        <label>Scenario <select id="scenario"><option>product-launch-readiness</option><option>reliability-incident</option><option>renewal-risk</option></select></label>
        <button onclick="callAdmin('state','GET')">State</button>
        <button onclick="callAdmin('reset','POST')">Reset</button>
        <button onclick="advance()">Advance 24h</button>
        <button onclick="callAdmin('events','GET')">Events</button>
        <button onclick="records()">All Records</button>
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
