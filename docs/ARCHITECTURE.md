# Architecture

## Boundary

```text
Source Simulator -> authenticated source feed -> Workforce One connector -> Workforce One evidence/provenance/reasoning
```

The simulator owns fictional source data only. Workforce One owns interpretation, ranking, recommendations, outcomes, and UI.

## Runtime Components

- `src/app.ts`: HTTP API, admin auth, connection-bound auth, request validation, operator console, source deep links, admin inspection routes, health, metrics, failure controls, benchmark, and connector-kit routes.
- `src/engine.ts`: deterministic organization-aware scenario engine, scenario instances, source-change ledger, v3 cursor feed, world revision, snapshots, dataset metadata, and visibility filtering.
- `src/adapters/*`: provider-shaped payload adapters and adapter registry.
- `src/data.ts`: fictional tenant and 10 scenario-pack definitions.
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
- current source record or tombstone payload
- permission scope

The v3 cursor stores only connection ID, world revision, and `afterSequence`. It remains compact regardless of dataset size.

Normal time advancement and manual triggers append new changes with increasing `ledgerSequence` values and keep the same `worldRevision`. Destructive reset/delete of a scenario instance, dataset generation, organization regeneration, and snapshot restore atomically rebuild the world and rotate `worldRevision`.

## Source Objects

The current source-object projection stores only the latest occurred source object per stable source identity for the current simulation clock.

Updates and deletions preserve source identity. Deleted provider semantics are represented as tombstoned source records.

## Scenario Packs And Instances

There are 10 scenario packs. Packs are reusable templates; they do not hold runtime clock or completion state. Each scenario instance is a persisted runtime entity with its own ID, pack ID, seed, dataset size, started time, current time, pause state, event occurrence-time map, triggered event IDs, event log, completion state, concrete participants, and account/product/project/service/workstream context.

Dataset size controls deterministic instance count:

- Small: 1 instance per pack.
- Medium: 8 instances per pack.
- Large: 40 instances per pack.

Scenario instances advance, pause, reset, delete, and trigger events independently. Reset/delete are destructive world replacements and invalidate previous cursors; ordinary advance/trigger append to the current world and preserve cursor continuity.

Automatically scheduled events occur at `startedAt + atHour`. Manual triggers occur at the selected instance's `currentTime`, even when that is earlier than the template's `atHour`. The persisted event occurrence time is the source of truth for created, updated, and deleted source timestamps.

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
- `snapshots`

Memory storage is for tests or explicitly selected local ephemeral development. SQLite is for local development and CI-level local durability. Preview, production, and Vercel-like environments reject memory and SQLite and require Postgres through `DATABASE_URL`.

The Postgres adapter preserves the synchronous storage interface by delegating database work to a worker-thread bridge backed by `pg.Pool`. This keeps the engine API stable while still using real Postgres transactions for world replacement. A future async storage interface could remove that bridge, but it is not required for Milestone 3 correctness.

## Observability

Every request receives a request ID and sanitized telemetry record. Logs and metrics include operation, path, status, duration, connection ID when present, cursor version/position when present, world revision, and safe error classification. Credentials, stack traces, and database connection strings are not logged by the simulator.

`/healthz` reports storage health, world revision, dataset metadata, organization summary, uptime, build version, and schema version. Admin-only metrics and request-inspection routes expose recent sanitized request data for connector debugging.

## Failure Simulation

Failure simulation is rule-based and deterministic. Rules can target operation, connection, source system, and every-Nth invocation. Supported modes include rate limits, timeouts, service outages, latency, partial pages, cursor corruption, auth failures, expired credentials, malformed payloads, permission changes, deletes, edits, late arrivals, duplicates, and stale objects.

Failure controls are disabled by default and require admin authentication at runtime.

## Public Vs Admin

Public catalog routes expose safe metadata only. Detailed people, organization graph, teams, source objects, source changes, assignments, relationships, and visibility comparison require admin authentication.
