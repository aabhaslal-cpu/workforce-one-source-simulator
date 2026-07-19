# Changelog

## Unreleased

### Added

- Admin-only `WorkforceOneSnapshotV1` export at `/v1/admin/exports/workforce-one-snapshot` for a future Workforce One bootstrap importer.
- Runtime Zod contract, JSON Schema, OpenAPI entry, checked example, and tests for the bootstrap snapshot artifact.
- Scenario packs now automatically add one role-private, source-native work artifact for every participant role, including PM release-readiness items, CS escalation/QBR follow-ups, engineering readiness tasks, and workbook-reference artifacts.

### Notes

- The export is read-only and credential-free. It does not change normal connection feed semantics, clock reconciliation, scenario generation, storage schema, or Workforce One code.
- Role-specific work artifacts are simulator source records only. They do not encode Workforce One conclusions and they flow through the existing adapter, ACL, ledger, and connection-feed paths.

## 0.3.0 - Milestone 3 Draft

### Added

- Production Postgres storage adapter with migrations and transaction-backed world replacement.
- CI Postgres service and conditional local Postgres parity tests.
- Persisted simulation clock and continuous orchestration state in memory, SQLite, and Postgres.
- Admin clock APIs and a protected cron-compatible tick endpoint backed by one canonical reconciliation operation.
- Feed-triggered realtime reconciliation so source feeds can advance the company world after cold starts or missed cron delivery.
- Deterministic continuous successor activity using the existing 10 scenario packs while preserving manual-trigger-only story beats.
- Postgres-backed distributed production rate limiting for admin, cron, and connection identities.
- Storage health checks for memory, SQLite, and Postgres.
- Structured request telemetry with request ID, connection ID, world revision, cursor metadata, operation, status, duration, and safe error classification.
- `/healthz` liveness and `/readyz` readiness, admin metrics, request inspector, storage inspector, deterministic benchmark endpoint, failure-mode configuration endpoints, and connector test-kit endpoint.
- Deterministic failure modes for rate limits, timeouts, 500/503, latency, partial pages, cursor corruption, auth failures, expired credentials, outages, malformed payloads, permission changes, deleted objects, edited objects, late-arriving objects, duplicate objects, and stale objects.
- Connector lifecycle test kit covering initial sync, incremental sync, late arrivals, updates/deletes, world reset, stale cursor rejection, new cursor acquisition, permission differences, and connection regeneration behavior.
- Operator console controls for clock, metrics, storage, ledger, snapshots, failure toggles, benchmark, and connector kit.
- Production configuration docs, `.env.example` updates, storage docs, operations docs, failure-mode docs, testing docs, scenario-authoring docs, provider-adapter docs, and Milestone 3 review notes.

### Changed

- Production-like runtimes now accept Postgres when `DATABASE_URL` is configured and continue to reject memory/SQLite.
- Preview/production rate limiting is distributed through Postgres and cannot be downgraded to process-local buckets.
- Postgres benchmarks now require a separate `SIMULATOR_BENCHMARK_DATABASE_URL` and reject reuse of the live `DATABASE_URL`.
- OpenAPI now includes operational, clock, cron, failure-mode, benchmark, and connector-kit endpoints.
- Benchmark output is compact and reports durations/counts only.
- Realtime reconciliation no longer auto-triggers manual events; continuous activity now uses scheduled nonmanual lifecycle horizons plus persisted successor due times.
- Bounded catch-up reports consumed wall time, remaining backlog, and whether the catch-up limit applied.
- Clock/orchestration configuration updates now reject with `clock_backlog_conflict` while bounded realtime catch-up backlog remains, so historical intervals are never processed under the wrong speed, mode, pause state, activity profile, or successor cadence.
- Reconciliation reports source-object create, update, delete, and total changed counts from projection changes.
- Source adapters now emit vendor-native supported-subset `rawPayload` objects validated by provider-family Zod schemas, with simulator metadata kept in the outer source record.
- Adapter coverage now preserves GitHub commit/release families, Salesforce Account/Contact/Event families, Gainsight milestone Timeline activities, constrained Productboard feature/note payloads, and Amplitude response-only raw payloads.
- Productboard payloads now use Productboard API v2 Entity and Notes GET response envelopes, Amplitude analytics payloads use the Dashboard REST active/new-user response shape, Gmail trash is modeled as an update, and no-body vendor deletes use the outer simulator `changeType` with a last-known payload.
- Gmail `internalDate` and RFC 2822 `Date` headers now stay tied to original message creation time, and no-body delete ledger entries copy the preceding source-object payload during world materialization.
- Checked-in provider-family fixtures and lifecycle validation now cover create, update, and delete drafts across every canonical source family.
- Error responses include safe classifications and correlation IDs without credentials, stack traces, or database strings.

### Verification

- Local suite: 88 Vitest tests total; 82 pass locally and 6 Postgres tests skip without `SIMULATOR_POSTGRES_TEST_URL`.
- GitHub Actions provides Postgres and is expected to run all 88 tests plus Vercel config validation, route smoke tests, Docker build, and container readiness smoke. A real Vercel CLI build runs only when `VERCEL_TOKEN` is configured; a tokenless early exit is not Vercel deployment proof.

### Performance Snapshot

Measured locally on July 11, 2026 with `docs-benchmark`:

- Memory large: generate 151.97 ms, advance 205.48 ms, trigger 196.19 ms, feed 55.02 ms, snapshot 8.70 ms, restore 134.29 ms, organization regeneration 154.50 ms.
- SQLite large: generate 160.21 ms, advance 231.39 ms, trigger 218.81 ms, feed 37.37 ms, snapshot 7.83 ms, restore 191.81 ms, organization regeneration 197.34 ms.
- Postgres benchmark is run only when a separate `SIMULATOR_BENCHMARK_DATABASE_URL` is available in the target environment.

## 0.2.0 - Milestone 2 Draft

### Added

- Compact v3 feed cursor over a deterministic source-change ledger.
- Independent persisted scenario instance states. Packs are templates; instances own clocks, pause state, event occurrence times, triggered events, event logs, participants, completion state, and contextual account/product/project/service/workstream values.
- Durable SQLite tables for `scenario_instance_states`, `world_state`, `source_change_ledger`, `source_objects`, and `dataset_metadata`.
- Dataset metadata and deterministic small, medium, and large dataset generation.
- Modular source adapter registry with Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk adapters.
- Ten scenario packs covering Product, Engineering, Customer Success, and cross-functional release workflows.
- Scenario instance catalog and admin inspection routes.
- Source-object projection, source-object history, and source-change admin routes.
- Organization relationship route and explicit dotted-line relationships.
- Cross-functional project, account, launch, and incident memberships.
- Operator console controls for datasets, scenario packs/instances, source objects, source changes, and source history.
- Tests for compact cursor behavior, stale world revisions, adapter coverage, scenario-pack coverage, dataset size ranges, source history, explicit relationships, new admin APIs, and SQLite ledger/metadata persistence.
- Tests for instance independence, real POST creation, occurred-only ledger behavior, manual trigger occurrence timing, atomic SQLite rollback, snapshot restore, and migration/runtime schema drift.

### Changed

- `SourceFeedBatchV1` now includes `cursorVersion: 3` and `worldRevision`.
- Feed cursors now contain only connection ID, world revision, and `afterSequence`; they do not contain consumed change IDs.
- The durable ledger now stores only occurred source changes. Normal advance and manual trigger append new changes without rotating world revision.
- Manual triggers now persist the selected instance's current simulation time as the event occurrence time, so initial changes appear immediately and delayed updates/deletions are relative to the actual trigger.
- Scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore are destructive world replacements that rotate world revision.
- Source materialization now uses provider adapters to shape raw payloads.
- Source IDs include scenario instance identity so medium and large datasets do not duplicate source identities.
- Snapshot payloads now restore independent scenario instance states and reconstruct the ledger/projection instead of treating saved future source history as authoritative.
- OpenAPI, JSON Schema, examples, docs, and tests are updated to the v3 cursor contract.

### Dataset Counts

- Small: 136 source changes, 10 scenario instances.
- Medium: 1,088 source changes, 80 scenario instances.
- Large: 5,440 source changes, 400 scenario instances.

### Not Proven

- Production Postgres durability remains Milestone 3.
- Production-like runtimes still fail closed rather than using memory or SQLite.
- Provider adapters are simplified simulator-owned representations, not complete vendor API clones.

## 0.1.0 - Milestone 1 Draft

### Added

- Initial standalone Workforce One source simulator service.
- Deterministic simulation model with scenario reset, advance, trigger, pause, resume, inspect, snapshot, and restore.
- Configurable deterministic organization generator with multiple people per role level.
- Cycle-free reporting hierarchy, manager assignments, direct reports, teams, work ownership, source identities, and permission group memberships.
- Organization catalog APIs and admin generation/configuration APIs.
- Person-level record visibility and visibility comparison inspection.
- Permission-scoped connection feed with opaque checkpoint cursors.
- `SourceFeedBatchV1` Zod contract, JSON Schema, OpenAPI spec, and example payloads.
- One fictional tenant, three departments, four role levels, and twelve role templates.
- Product launch readiness, reliability incident, and renewal risk scenarios.
- Internal operator console with organization controls.
- Documentation set for architecture, organization, contract, scenarios, personas, source systems, security, deployment, integration, and milestones.
- CI workflow and automated verification suite.

### Hardened

- Replaced the universal connection secret with connection-bound credentials.
- Added server-side URL connection ID matching and 403 on credential/URL mismatch.
- Added production-like credential validation for missing, development, identical, unknown, and revoked credentials.
- Protected detailed people, teams, organization tree, source identities, assignments, and visibility comparison behind admin authentication.
- Reduced unauthenticated catalog exposure to safe high-level metadata.
- Added strict Zod request validation, malformed JSON handling, cursor validation, bounded page size, bounded body size, bounded time advancement, and bounded organization generation.
- Added durable local SQLite storage for scenario states, organization configuration, and snapshots.
- Added fail-closed production-like behavior when durable storage is unavailable instead of using process memory.
- Corrected temporal source updates so `updatedAt` and updated payload metadata appear only after the simulation clock reaches the update time.
- Added simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}` with connection visibility enforcement.
