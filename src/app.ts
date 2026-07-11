import { Hono } from "hono";
import { SourceSimulator, HttpError } from "./engine.js";
import { scenarios } from "./data.js";
import { roleTemplates } from "./organization.js";
import { sourceSystems, type DatasetSize } from "./domain.js";

export interface AppOptions {
  simulator?: SourceSimulator;
  adminKey?: string;
  connectionSecret?: string;
}

export function createApp(options: AppOptions = {}) {
  const simulator = options.simulator ?? new SourceSimulator({
    seed: process.env.SIMULATOR_DEFAULT_SEED,
    datasetSize: parseDatasetSize(process.env.SIMULATOR_DEFAULT_DATASET_SIZE),
    baseUrl: process.env.SIMULATOR_PUBLIC_BASE_URL,
  });
  const adminKey = options.adminKey ?? process.env.SIMULATOR_ADMIN_API_KEY ?? "dev-admin-key";
  const connectionSecret = options.connectionSecret ?? process.env.SIMULATOR_CONNECTION_SECRET ?? "dev-connection-secret";
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as 400 | 404);
    }
    return c.json({ error: "Internal simulator error" }, 500);
  });

  app.get("/", (c) => c.redirect("/console"));
  app.get("/healthz", (c) => c.json({ ok: true, schemaVersion: "source-feed.v1" }));
  app.get("/console", (c) => c.html(consoleHtml));

  app.get("/v1/catalog", (c) => c.json(simulator.catalog()));
  app.get("/v1/catalog/sources", (c) => c.json({ sources: sourceSystems }));
  app.get("/v1/catalog/scenarios", (c) => c.json({ scenarios }));
  app.get("/v1/catalog/seats", (c) => c.json({ roleTemplates }));
  app.get("/v1/catalog/people", (c) => c.json({ people: simulator.people() }));
  app.get("/v1/catalog/people/:personId", (c) => c.json(simulator.person(c.req.param("personId"))));
  app.get("/v1/catalog/organization", (c) => c.json(simulator.organizationSummary()));
  app.get("/v1/catalog/organization/tree", (c) => c.json(simulator.organizationTree()));
  app.get("/v1/catalog/teams", (c) => c.json({ teams: simulator.teams() }));
  app.get("/v1/catalog/teams/:teamId", (c) => c.json(simulator.team(c.req.param("teamId"))));

  app.get("/v1/connections/:connectionId/manifest", (c) => {
    if (!hasSecret(c.req.header(), connectionSecret, "x-connection-secret")) return c.json({ error: "Unauthorized" }, 401);
    return c.json(simulator.manifest(c.req.param("connectionId")));
  });

  app.get("/v1/connections/:connectionId/records", (c) => {
    if (!hasSecret(c.req.header(), connectionSecret, "x-connection-secret")) return c.json({ error: "Unauthorized" }, 401);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    return c.json(simulator.feed(c.req.param("connectionId"), c.req.query("cursor"), limit));
  });

  app.use("/v1/admin/*", async (c, next) => {
    if (!hasSecret(c.req.header(), adminKey, "x-admin-api-key")) return c.json({ error: "Unauthorized" }, 401);
    await next();
  });

  app.post("/v1/admin/scenarios/:scenarioId/reset", async (c) => c.json(simulator.resetScenario(c.req.param("scenarioId"), await optionalJson(c.req.raw))));
  app.post("/v1/admin/scenarios/:scenarioId/advance", async (c) => c.json(simulator.advanceScenario(c.req.param("scenarioId"), await optionalJson(c.req.raw))));
  app.post("/v1/admin/scenarios/:scenarioId/trigger", async (c) => {
    const body = await optionalJson(c.req.raw);
    const eventId = typeof body.eventId === "string" ? body.eventId : "manual-review";
    return c.json(simulator.triggerScenarioEvent(c.req.param("scenarioId"), eventId));
  });
  app.post("/v1/admin/scenarios/:scenarioId/pause", (c) => c.json(simulator.pauseScenario(c.req.param("scenarioId"))));
  app.post("/v1/admin/scenarios/:scenarioId/resume", (c) => c.json(simulator.resumeScenario(c.req.param("scenarioId"))));
  app.get("/v1/admin/scenarios/:scenarioId/state", (c) => c.json(simulator.state(c.req.param("scenarioId"))));
  app.get("/v1/admin/scenarios/:scenarioId/events", (c) => c.json({ events: simulator.eventLog(c.req.param("scenarioId")) }));
  app.get("/v1/admin/records", (c) => c.json({ records: simulator.allRecords() }));
  app.get("/v1/admin/connections", (c) => c.json({ connections: simulator.catalog().connections }));
  app.get("/v1/admin/snapshots", (c) => c.json({ snapshots: simulator.listSnapshots() }));
  app.post("/v1/admin/snapshots", (c) => c.json(simulator.createSnapshot()));
  app.post("/v1/admin/snapshots/:snapshotId/restore", (c) => c.json(simulator.restoreSnapshot(c.req.param("snapshotId"))));
  app.post("/v1/admin/organization/generate", async (c) => c.json(simulator.regenerateOrganization(await optionalJson(c.req.raw))));
  app.post("/v1/admin/organization/reset", (c) => c.json(simulator.resetOrganization()));
  app.get("/v1/admin/organization/config", (c) => c.json(simulator.getOrganizationConfig()));
  app.put("/v1/admin/organization/config", async (c) => c.json(simulator.putOrganizationConfig(await optionalJson(c.req.raw) as any)));
  app.get("/v1/admin/people/:personId/records", (c) => c.json(simulator.recordsForPerson(c.req.param("personId"))));
  app.get("/v1/admin/people/:personId/compare/:otherPersonId", (c) => c.json(simulator.comparePersonVisibility(c.req.param("personId"), c.req.param("otherPersonId"))));

  return app;
}

async function optionalJson(request: Request): Promise<Record<string, any>> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return {};
  }
}

function hasSecret(headers: Headers, expected: string, headerName: string): boolean {
  const headerSecret = headers.get(headerName);
  const auth = headers.get("authorization");
  const bearerSecret = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return headerSecret === expected || bearerSecret === expected;
}

function parseDatasetSize(value: string | undefined): DatasetSize | undefined {
  if (value === "small" || value === "medium" || value === "large") return value;
  return undefined;
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
function show(value) { out.textContent = JSON.stringify(value, null, 2); }
async function getJson(url, opts = {}) { const res = await fetch(url, opts); return res.json(); }
async function callAdmin(action, method) { show(await getJson('/v1/admin/scenarios/' + scenario() + '/' + action, { method, headers: { 'x-admin-api-key': key() } })); }
async function advance() { show(await getJson('/v1/admin/scenarios/' + scenario() + '/advance', { method: 'POST', headers: { 'x-admin-api-key': key(), 'content-type': 'application/json' }, body: JSON.stringify({ hours: 24 }) })); }
async function records() { show(await getJson('/v1/admin/records', { headers: { 'x-admin-api-key': key() } })); }
async function loadOrg() { show(await getJson('/v1/catalog/organization/tree')); }
async function loadPeople() {
  const data = await getJson('/v1/catalog/people');
  const dept = document.getElementById('department').value;
  const level = document.getElementById('level').value;
  const search = document.getElementById('search').value.toLowerCase();
  show({ people: data.people.filter(p => (!dept || p.department === dept) && (!level || p.roleLevel === level) && (!search || p.name.toLowerCase().includes(search) || p.email.includes(search))) });
}
async function generateOrg() { show(await getJson('/v1/admin/organization/generate', { method: 'POST', headers: { 'x-admin-api-key': key(), 'content-type': 'application/json' }, body: JSON.stringify({ seed: document.getElementById('orgSeed').value }) })); }
async function resetOrg() { show(await getJson('/v1/admin/organization/reset', { method: 'POST', headers: { 'x-admin-api-key': key() } })); }
async function personDetail() { show(await getJson('/v1/catalog/people/' + document.getElementById('personA').value)); }
async function personRecords() { show(await getJson('/v1/admin/people/' + document.getElementById('personA').value + '/records', { headers: { 'x-admin-api-key': key() } })); }
async function comparePeople() { show(await getJson('/v1/admin/people/' + document.getElementById('personA').value + '/compare/' + document.getElementById('personB').value, { headers: { 'x-admin-api-key': key() } })); }
</script>
</body>
</html>`;
