# Workforce One Source Simulator

A standalone source-data simulator for Workforce One ingestion testing.

The simulator behaves like an external source platform. It emits fictional, permission-scoped source records through an authenticated cursor feed. It does not import Workforce One code, write to a Workforce One database, or generate Workforce One conclusions.

## Current State

Milestone 3 is implemented as the final production-hardening milestone.

Built:

- Strict TypeScript/Hono service.
- Deterministic organization generator for Product, Engineering, and Customer Success.
- Multiple actual people at IC, Manager, Director, and VP levels.
- Uneven spans of control, primary reporting lines, dotted-line relationships, project teams, account teams, launch membership, incident membership, source identities, permission groups, and work ownership.
- Connection-bound authentication where each credential resolves server-side to exactly one connection ID.
- Admin-gated people, organization, team, source, dataset, relationship, and visibility inspection.
- Safe public catalog metadata only.
- Modular source adapters for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude-style analytics, GitHub, PagerDuty-style incidents, Salesforce, Gainsight-style customer success, and Zendesk-style support, with provider-family Zod validation and manifest parity tests.
- Eleven scenario packs covering regular workdays, launch readiness, adoption lag, roadmap tradeoff, incident response, delivery slip, technical debt/staffing risk, renewal risk, implementation blocker, expansion opportunity, and major cross-functional release.
- Persisted scenario instance state. Packs are reusable templates; instances hold their own seed, dataset size, clock, pause state, event occurrence times, event log, completion state, participants, and account/project/product/service/workstream context.
- Persisted company clock with manual mode, realtime mode, bounded catch-up, speed multiplier, pause/resume, restart persistence, feed-triggered micro-reconciliation, and a protected cron-compatible reconciliation endpoint.
- Clock configuration updates fail closed with `clock_backlog_conflict` when bounded realtime catch-up still has wall-clock backlog and the request changes time-affecting settings; operators must drain backlog with `POST /v1/admin/clock/reconcile` first.
- Deterministic continuous activity orchestrator. Completed instances can create successor instances from the existing 11 packs, preserving one shared Product/Engineering/Customer Success company world.
- Compact v3 source feed cursor over a deterministic source-change ledger: connection ID, world revision, and `afterSequence`.
- Occurred-only durable source-change ledger. Normal time advancement appends newly reached changes without rotating world revision.
- Manual triggers occur at the selected instance's current simulation time; updates and deletions are calculated relative to that actual trigger time.
- Destructive scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore atomically reconstruct the world and rotate world revision.
- Source updates, late arrivals, corrected analytics, reschedules, archived/deleted objects, and conflicting partial evidence.
- Small, medium, and large deterministic datasets.
- SQLite local persistence for scenario instance states, legacy scenario states, organization config, world revision, source-change ledger, current source-object projection, dataset metadata, snapshots, simulation clock, and orchestration state.
- Production Postgres persistence for the same durable state, with transaction-backed world replacement and CI parity tests.
- Postgres-backed distributed rate limiting in preview/production. Local/test may use the in-memory limiter.
- Structured request telemetry, sanitized error envelopes with correlation IDs, operational metrics, `/healthz` liveness, `/readyz` readiness, storage inspection, and request inspection.
- Deterministic failure simulation for connector development: rate limits, timeouts, 500/503, latency, partial pages, cursor corruption, auth failures, expired credentials, outages, malformed payloads, permission changes, deletes, edits, late arrivals, duplicate objects, and stale objects.
- Connector test kit covering initial sync, incremental sync, late arrivals, updates/deletes, world reset, stale cursor rejection, new cursor acquisition, permission differences, and connection-regeneration behavior.
- Built-in deterministic benchmark harness for small, medium, and large datasets across memory, SQLite, and Postgres when a separate `SIMULATOR_BENCHMARK_DATABASE_URL` is configured.
- Simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}` with the same connection visibility checks as feeds.
- Internal operator console at `/console` with organization, scenario, clock, ledger, storage, snapshot, metrics, failure-mode, benchmark, and connector-kit controls.

Dataset counts with the current implementation:

- Small: 159 source changes, 11 scenario instances.
- Medium: 1,272 source changes, 88 scenario instances.
- Large: 6,360 source changes, 440 scenario instances.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development credentials are fictional and documented:

- Admin: `x-admin-api-key: dev-admin-key`
- Connection: `x-connection-secret: dev-connection-secret:<connectionId>`

Examples:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/v1/catalog
curl http://localhost:3000/v1/catalog/scenario-packs
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/catalog/scenario-instances
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/datasets/current
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/metrics
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/source-changes
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/clock
curl -H 'x-connection-secret: dev-connection-secret:conn-product-manager' \
  'http://localhost:3000/v1/connections/conn-product-manager/records?limit=5'
```

Generate a larger deterministic dataset:

```bash
curl -X POST -H 'x-admin-api-key: dev-admin-key' \
  -H 'content-type: application/json' \
  -d '{"seed":"demo-seed","datasetSize":"medium"}' \
  http://localhost:3000/v1/admin/datasets/generate
```

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

The Milestone 3 suite has 88 Vitest tests. Local runs without `SIMULATOR_POSTGRES_TEST_URL` execute 82 tests and skip the 6 Postgres integration tests. GitHub Actions provides Postgres and runs the full suite plus Vercel config validation, route smoke tests, Docker build, and a container readiness smoke test. A real `vercel build` runs in CI only when `VERCEL_TOKEN` is configured; without that token, the optional Vercel build step is intentionally skipped and the owner-run preview verification command in `docs/DEPLOYMENT.md` remains required before calling Vercel deployability fully proven.

## Deployment Honesty

Local durable storage defaults to SQLite. Memory storage is available only for tests or explicitly selected local ephemeral development.

Preview, production, and Vercel-like runtimes reject missing credentials, known development credentials, identical admin/connection credentials, memory storage, SQLite storage, and injected local-storage simulators. Production-like runtimes require `DATABASE_URL` with Postgres.

Postgres is implemented and CI-proven for the simulator storage, clock, orchestration, and distributed rate-limit contracts. Operational readiness still depends on the deployment owner providing database backups, network controls, secret rotation, and monitoring around this service.

## Documentation Map

- `START_HERE.md`: new-session checklist and hard boundaries.
- `ACTIVE_WORK.md`: current branch, baseline, implementation status, verification, and limitations.
- `docs/MILESTONES.md`: exactly three milestones.
- `docs/ARCHITECTURE.md`: engine, ledger, storage, adapter, and API architecture.
- `docs/OPERATIONS.md`: health, metrics, logs, diagnostics, backups, and recovery.
- `docs/STORAGE.md`: memory, SQLite, Postgres, migrations, and transaction behavior.
- `docs/FAILURE_MODES.md`: deterministic failure simulation matrix.
- `docs/TESTING.md`: verification suite, Postgres parity, connector kit, and performance sanity.
- `docs/SCENARIO_AUTHORING.md`: how to author scenario packs without breaking ledger semantics.
- `docs/PROVIDER_ADAPTERS.md`: provider adapter expansion rules.
- `docs/CHANGE_LEDGER.md`: v3 cursor and world-revision behavior.
- `docs/SOURCE_ADAPTERS.md`: adapter responsibilities and coverage.
- `docs/SOURCE_CONTRACTS.md`: vendor-native raw payload contract manifest notes.
- `docs/SCENARIOS.md`: 11 scenario packs.
- `docs/DATASET_GENERATION.md`: small/medium/large behavior.
- `docs/ORGANIZATION.md`: organization graph and relationships.
- `docs/SECURITY.md`: auth, catalog exposure, permissions, and fail-closed rules.
- `docs/CONTRACT.md` and `openapi/source-simulator.v1.yaml`: external contract.
- `docs/DEPLOYMENT.md`: local, CI, preview, and production deployment.
- `docs/WORKFORCE_ONE_INTEGRATION.md`: integration boundary.

## Non-Goals

The simulator does not build Workforce One UI, AI reasoning, recommendations, priorities, Signals, Forces, Objectives, Outcomes, real OAuth integrations, public demos, load tests, or a direct Workforce One database importer.
