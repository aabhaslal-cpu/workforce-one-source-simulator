# Architecture

## Shape

```text
Source Simulator
  -> authenticated source-change feed
  -> Workforce One connector
  -> connector-ingress gateway
  -> evidence and provenance
  -> Workforce One product reasoning and UI
```

The simulator owns fictional source data only. Workforce One owns interpretation.

## Runtime Components

- `src/app.ts`: HTTP API, connection-bound auth, admin auth, request validation, operator console, source deep links.
- `src/engine.ts`: deterministic scenario engine, source-change stream, checkpoint cursors, snapshots, temporal source mutations, organization-aware visibility.
- `src/domain.ts`: shared domain types.
- `src/organization.ts`: deterministic organization generator, role templates, reporting tree, and person-level connections.
- `src/data.ts`: fictional tenant and M1 scenario templates.
- `src/contracts.ts`: SourceFeedBatchV1 Zod schemas.
- `src/storage.ts`: storage interface, in-memory test adapter, and durable local SQLite adapter.

## Determinism

Record identity is derived from seed, organization seed, scenario, event, source system, object type, and template ID. The same seed, organization configuration, scenario state, and trigger sequence produce the same organization and records. Different seeds produce different stable people and source IDs while preserving valid structure.

Source updates are deterministic timeline mutations. A record with an update time keeps the same source ID and initial payload until the simulation clock reaches the update time; only then does `updatedAt` and the updated simulator payload metadata appear.

Connection feeds are built from deterministic source changes, not offset pagination over a mutable record list. A v2 cursor is bound to one connection and records consumed change IDs so later creates or updates cannot cause skipped or duplicated feed items. The server returns a checkpoint cursor even when `hasMore` is false.

## Organization

The simulator generates actual people, not only persona labels. Role templates define categories such as Product Manager or VP Customer Success; generated people occupy those templates. Each person has a manager, direct reports, team, source identities, work ownership, permission groups, and person-level source connection.

## State

Scenario state includes:

- scenario ID
- seed
- dataset size
- start time
- current time
- paused flag
- triggered event IDs
- debugging event log

Organization state includes:

- organization seed
- organization configuration
- generated people
- teams
- reporting relationships
- validation result

The event log is for operator inspection only and is not part of the Workforce One data contract.

## Permissions

Connections map server-side to a concrete generated person, allowed source systems, and allowed groups. Each connection credential resolves to exactly one connection ID. The URL `connectionId` must match the authenticated connection ID or the API returns 403.

Clients cannot choose arbitrary tenant, department, person, role, or group scope. Reporting hierarchy does not automatically grant visibility; ACLs and source memberships do.

## Public vs Admin Catalog

Unauthenticated catalog routes expose only safe high-level metadata: supported source systems, contract version, scenario names, role-template count, and aggregate organization counts. Detailed people, teams, source identities, assignments, organization tree, and visibility comparison require admin authentication.

## Storage

The engine talks to a storage interface. Milestone 1 includes:

- `MemorySimulatorStorage` for tests and explicitly selected local ephemeral development only.
- `SQLiteSimulatorStorage` for durable local scenario state, organization configuration, and snapshots.

Production-like runtimes must fail closed when durable storage is unavailable. This draft does not claim proven production Postgres readiness.

Preview, production, and Vercel-like runtimes reject memory and SQLite storage, including injected `AppOptions.storage` or `AppOptions.simulator` instances. Until a proven Postgres adapter exists, production-like startup fails closed instead of silently falling back to local storage.
