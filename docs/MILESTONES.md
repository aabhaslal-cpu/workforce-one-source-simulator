# Milestones

Use exactly three milestones. Smaller task lists are internal implementation phases, not new milestones.

## Milestone 1: Core Simulator Platform And Contract

Merged into `main` before Milestone 2 started.

Delivered:

- Standalone TypeScript/Hono service.
- Deterministic organization generator with multiple people per role level.
- Connection-bound authentication and admin-gated detailed catalog.
- Safe public metadata catalog.
- SourceFeedBatchV1, JSON Schema, OpenAPI, and examples.
- Strict request validation.
- Local SQLite persistence for core state.
- Temporal updates, source deep links, snapshots, and operator console foundation.
- Production-like fail-closed behavior for unsafe credentials/storage.

## Milestone 2: Complete Department, Level, Source, And Scenario Coverage

Merged before Milestone 3 started.

Delivered:

- Compact v3 cursor over an append-only deterministic source-change ledger.
- Independent persisted scenario instance runtime state.
- Occurred-only source-change ledger with append semantics for normal advance/trigger.
- Atomic world replacement for destructive reset/delete, dataset generation, organization regeneration, and snapshot restore.
- Durable world revision, source-change ledger, current source-object projection, and dataset metadata.
- Modular source adapters for all 12 required source systems.
- Ten scenario packs across Product, Engineering, Customer Success, and cross-functional release work.
- Deterministic small, medium, and large datasets.
- Concrete generated people on source artifacts.
- Cross-functional project, account, launch, and incident memberships.
- Dotted-line relationships that do not replace primary managers.
- Source lag, updates, deleted/tombstoned objects, corrected metrics, reschedules, reopened support tickets, and conflicting source evidence.
- Admin APIs and operator console expansion for datasets, scenario instances, source changes, source objects, source history, and organization relationships.
- Tests covering ledger/cursor behavior, adapters, scenarios, datasets, relationships, APIs, SQLite persistence, and existing Milestone 1 protections.

Acceptance target: Workforce One can ingest a coherent fictional company source surface with different evidence at IC, Manager, Director, and VP levels, without the simulator generating Workforce One conclusions.

## Milestone 3: Production Hardening And Workforce One Integration Readiness

Current branch: `milestone-3/production-hardening`.

Delivered in this draft:

- Proven production Postgres storage adapter.
- SQLite/Postgres storage parity and restart persistence tests.
- Production-like startup with Postgres and continued fail-closed behavior for memory/SQLite.
- Deployment verification, smoke-test guidance, and runbooks.
- Deterministic failure simulation controls.
- Structured safe logging and operational telemetry.
- Health, metrics, request inspection, storage inspection, benchmark, and connector-kit admin APIs.
- Connector lifecycle compatibility kit for initial sync, incremental sync, late arrivals, updates/deletes, reset, stale cursor, new cursor, permission differences, and connection regeneration.
- Performance sanity benchmark for small, medium, and large datasets.
- Operator console operational controls.
- Final architecture, security, operations, and Workforce One integration reviews.

Acceptance target: the simulator can run as an independent internal platform beside Workforce One with production Postgres persistence, deterministic replay, operational diagnostics, connector failure testing, and truthful deployment documentation.
