# Architecture

## Boundary

```text
Source Simulator -> authenticated source feed -> Workforce One connector -> Workforce One evidence/provenance/reasoning
```

The simulator owns fictional source data only. Workforce One owns interpretation, ranking, recommendations, outcomes, and UI.

## Runtime Components

- `src/app.ts`: canonical Hono-native Vercel entrypoint that creates and default-exports the app.
- `src/simulator-app.ts`: HTTP API, admin auth, connection-bound auth, request validation, operator console, source deep links, admin inspection routes, health, metrics, failure controls, benchmark, and connector-kit routes.
- `src/local-server.ts`: standalone local/container Node server for the same Hono app.
- `src/engine.ts`: deterministic organization-aware scenario engine, scenario instances, persisted simulation clock, continuous activity orchestration, source-change ledger, v3 cursor feed, world revision, snapshots, dataset metadata, and visibility filtering.
- `src/adapters/*`: provider-shaped payload adapters and adapter registry.
- `src/data.ts`: fictional tenant and 11 scenario-pack definitions.
- `src/organization.ts`: role templates, deterministic people/teams/reporting graph, dotted-line relationships, cross-functional memberships, and connection IDs.
- `src/storage.ts`: storage interface, memory test adapter, SQLite local durable adapter, and Postgres production adapter.
- `src/observability.ts`: structured request telemetry and operational counters.
- `src/failures.ts`: deterministic failure-mode configuration and feed mutation helpers.
- `src/performance.ts`: deterministic benchmark harness.
- `src/connector-kit.ts`: reference connector lifecycle kit.
- `src/contracts.ts`: Zod runtime contract for `SourceFeedBatchV1`.

## Determinism

Stable IDs are derived from deterministic inputs: organization config, organization seed, dataset seed, dataset size, scenario pack, scenario instance, event, template, source system, and change type.

The code must not use uncontrolled `Math.random()`, `Date.now()`, random UUIDs, real people, routable emails, or real customer data.

## Change Ledger

The feed is built from a deterministic source-change ledger, not offset pagination over a mutable list.

The durable ledger contains only changes that have occurred through initial instance creation, time advancement, manual triggers, or deterministic world reconstruction after a destructive operation. Future planned emissions stay in scenario definitions and are not exposed by `GET /v1/admin/source-changes`.

Each ledger entry has:

- monotonic `ledgerSequence`
- `worldRevision`
- `changeId`
- `changeType`
- source system and source ID
- change time and source occurrence time
- scenario pack and scenario instance IDs
- business event and template IDs
- current source record payload
- permission scope

The v3 cursor stores only connection ID, world revision, and `afterSequence`. It remains compact regardless of dataset size.

Normal time advancement, manual triggers, and realtime clock reconciliation append new changes with increasing `ledgerSequence` values and keep the same `worldRevision`. Destructive reset/delete of a scenario instance, dataset generation, organization regeneration, and snapshot restore atomically rebuild the world and rotate `worldRevision`.

## Company Clock And Reconciliation

The simulator has one persisted company clock, not one process-local timer.

Clock state includes:

- mode: `manual` or `realtime`
- wall-clock anchor
- simulation-clock anchor
- last reconciled wall time
- last reconciled simulation time
- speed multiplier
- pause state
- continuous-activity flag
- maximum catch-up window
- last reconciliation report

All realtime progression passes through `reconcileSimulationClock(now)`. The operation runs inside the same storage mutation lock as world replacement, calculates bounded elapsed simulation time from server-owned wall time, advances eligible non-paused instances by the same delta, materializes newly due source changes, creates bounded deterministic successor instances when continuous activity is enabled, updates source-object projection and dataset metadata, persists the clock checkpoint, and commits atomically.

Clock configuration updates first run the same bounded reconciliation under the current persisted clock configuration inside one atomic world mutation. If `wallTimeBacklogRemainingMs` remains and the request changes a time-affecting field (`mode`, `speedMultiplier`, `paused`, `maxCatchUpSeconds`, `continuousActivity`, `activityProfile`, `maxSuccessorInstancesPerReconciliation`, or `minSuccessorIntervalHours`), the service rejects the update with `409 clock_backlog_conflict` and rolls back the evaluation reconciliation. Operators must explicitly call `POST /v1/admin/clock/reconcile` until backlog reaches zero before changing those settings.

Feed polling calls bounded micro-reconciliation before reading authorized ledger changes in realtime mode. The micro-reconciliation cap defaults to five minutes of wall-clock backlog so connection reads stay inside connector request budgets while later polls continue draining historical backlog. `/api/cron/tick` calls the normal reconciliation operation and is only a convenience to keep the world warm; correctness does not depend on a permanently running process.

## Source Objects

The current source-object projection stores only the latest occurred source object per stable source identity for the current simulation clock.

Updates and deletions preserve source identity. Deleted or archived provider semantics are represented with provider-native status/archive fields where available and the outer source-change `changeType`.

## Scenario Packs And Instances

There are 11 scenario packs. Packs are reusable templates; they do not hold runtime clock or completion state. Each scenario instance is a persisted runtime entity with its own ID, pack ID, seed, dataset size, started time, current time, pause state, event occurrence-time map, triggered event IDs, event log, completion state, concrete participants, and account/product/project/service/workstream context.

Dataset size controls deterministic instance count:

- Small: 1 instance per pack.
- Medium: 8 instances per pack.
- Large: 40 instances per pack.

Scenario instances advance, pause, reset, delete, and trigger events independently. Reset/delete are destructive world replacements and invalidate previous cursors; ordinary advance/trigger append to the current world and preserve cursor continuity.

Automatically scheduled events occur at `startedAt + atHour`. Manual triggers occur at the selected instance's `currentTime`, even when that is earlier than the template's `atHour`. The persisted event occurrence time is the source of truth for created, updated, and deleted source timestamps.

Realtime reconciliation never auto-triggers manual-labeled story beats. Manual events occur only through the explicit trigger API and keep the selected instance's current simulation time as their persisted occurrence time. Continuous orchestration uses a deterministic lifecycle horizon based on scheduled nonmanual activity and delayed update/delete windows, so successor generation does not depend on silently reclassifying manual events as automatic.

## Continuous Activity

Continuous activity reuses the existing 11 scenario packs. It does not add hidden Workforce One-specific scenario logic.

When enabled, completed scenario instances become eligible for deterministic successor instances. Successor IDs, seeds, start times, and account/product/project/service/workstream context are derived from persisted orchestration state and the completed instance. Per-reconciliation creation limits and minimum successor intervals prevent unbounded catch-up.

The major cross-functional release pack continues the shared storyline across Product, Engineering, Customer Success, all four organizational levels, and all 12 source systems.

## Organization

The simulator generates actual fictional people, not generic persona labels. Role templates are categories; generated people occupy them.

The organization includes:

- primary manager/report relationships
- dotted-line relationships
- department teams
- manager teams
- cross-functional project teams
- account teams
- launch team membership
- incident responder membership
- product, project, account, and workstream assignments

Reporting hierarchy does not grant record visibility by itself. Visibility comes from source ACLs, groups, explicit memberships, and person-specific source connections.

## Storage

SQLite and Postgres persist:

- `scenario_states`
- `scenario_instance_states`
- `organization_config`
- `world_state`
- `source_change_ledger`
- `source_objects`
- `dataset_metadata`
- `simulation_clock_state`
- `continuous_orchestration_state`
- `snapshots`

Postgres also persists `rate_limit_buckets` for distributed preview/production request limiting.

Memory storage is for tests or explicitly selected local ephemeral development. SQLite is for local development and CI-level local durability. Preview, production, and Vercel-like environments reject memory and SQLite and require Postgres through `DATABASE_URL`.

The storage interface is async. Memory and SQLite expose async wrappers for local/test use; Postgres uses `pg.Pool` directly with bounded query timeouts. World mutations are serialized through adapter-level locking: memory uses an in-process mutation queue, SQLite uses one database transaction, and Postgres uses one database transaction plus an advisory lock.

Postgres migrations are versioned files recorded in `schema_migrations` with checksums. Runtime code never performs destructive Postgres resets. Tests and benchmarks use owned `sim_test_*` or `sim_benchmark_*` schemas.

## Observability

Every request receives a request ID and sanitized telemetry record. Logs and metrics include operation, path, status, duration, connection ID when present, cursor version/position when present, world revision, and safe error classification. Credentials, stack traces, and database connection strings are not logged by the simulator.

`/healthz` is storage-independent liveness; `/readyz` reports storage health, world revision, safe clock state, dataset metadata, organization summary, uptime, build version, and schema version. Admin-only metrics and request-inspection routes expose recent sanitized request data for connector debugging.

## Failure Simulation

Failure simulation is rule-based and deterministic. Rules can target operation, connection, source system, and every-Nth invocation. Supported modes include rate limits, timeouts, service outages, latency, partial pages, cursor corruption, auth failures, expired credentials, malformed payloads, permission changes, deletes, edits, late arrivals, duplicates, and stale objects.

Failure controls are disabled by default and require admin authentication at runtime.

## Rate Limits

Real service rate limits are separate from failure simulation. They are keyed by authenticated admin identity, cron identity, or resolved connection ID and return safe `429` envelopes with `Retry-After`, correlation ID, and `rate_limit` classification. Preview/production use Postgres-backed distributed buckets; development/test may use local in-memory buckets.

## Vercel And Warm Processes

The Vercel path uses one Hono-native entrypoint: `src/app.ts` imports `createApp()` from `src/simulator-app.ts`, awaits the app, and default-exports it. `vercel.json` configures only that function with bounded duration and includes `migrations/*.sql` so Postgres migrations are available at runtime.

The repository intentionally has no `api/index.ts` wrapper, no Vercel route rewrite to a second entrypoint, no explicit function runtime override, no static output directory, no Vercel build command, and no configured Vercel cron block.

Warm Vercel Function instances cannot trust cached organization or connection definitions. Before connection-sensitive authorization and admin detailed catalog reads, the app refreshes persisted organization config and rebuilds people, teams, role-alias connections, person-specific connections, and permission mappings when the stored organization changes.

## Public Vs Admin

Public catalog routes expose safe metadata only. Detailed people, organization graph, teams, source objects, source changes, assignments, relationships, and visibility comparison require admin authentication.
