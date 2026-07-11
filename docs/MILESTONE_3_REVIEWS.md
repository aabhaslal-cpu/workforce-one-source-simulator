# Milestone 3 Pre-Implementation Reviews

Milestone 3 begins from Milestone 2 head `f73746113007b87530811f60f51297bff968ccf7` on branch `milestone-3/production-hardening`.

These reviews were completed before runtime implementation. Their purpose is to define the hardening work without changing the simulator's business surface.

## Review 1: Architecture

### Verified

- Layering is mostly clean: `app.ts` owns HTTP/auth/validation, `engine.ts` owns deterministic simulation, `organization.ts` owns org generation, `storage.ts` owns persistence, and `src/adapters/*` owns provider payload shaping.
- Adapter boundaries are usable: provider-specific payload logic is isolated behind the adapter registry and the core engine calls `create`, `update`, `remove`, and validation methods.
- Storage boundary exists and is the right extension point for Postgres: `SimulatorStorage` already includes scenario instance state, world revision, ledger, projection, metadata, snapshots, and atomic `replaceWorld`.
- API boundaries are explicit and admin routes are grouped under `/v1/admin/*`.
- Testability is strong for core deterministic behavior because the simulator accepts injected storage, seed, dataset size, clock, and organization config.
- Dependency direction is mostly inward: adapters and storage do not call HTTP code; app calls engine; engine calls adapters/storage/organization.

### Technical Debt And Cleanup

- `src/app.ts` is doing too much: routing, auth config, storage selection, console HTML, request validation, and error formatting live in one file.
- `src/storage.ts` duplicates SQLite statement patterns. Postgres should not copy those line-by-line without shared schema/migration constants and parity tests.
- The storage interface still has legacy pack-level `ScenarioState` methods. They are retained for compatibility, but runtime behavior now depends on `ScenarioInstanceState`.
- The operator console is embedded HTML/JS in `app.ts`; Milestone 3 can improve usefulness but should avoid a frontend rewrite.
- Request observability is absent; there is no request ID, duration, operation classification, or safe error correlation.
- Configuration validation is split across ad hoc environment reads. Milestone 3 should centralize config parsing and fail fast.
- There is no dedicated connector test kit. Existing tests cover feed mechanics but not a reference connector lifecycle.

### Implementation Direction

- Keep the public API stable.
- Add Postgres as another storage implementation behind `SimulatorStorage`.
- Extract operational support as small modules: config, logging, metrics, failure injection, health, performance harness, connector kit.
- Keep provider expansion through adapters; do not add new business scenarios.

## Review 2: Security

### Verified

- Admin and connection credentials are separate classes.
- Connection credentials resolve server-side to exactly one connection ID.
- URL connection mismatch returns 403.
- Unknown and revoked credentials fail closed.
- Public catalog excludes people, assignments, source objects, source changes, and credential material.
- Detailed people, organization, teams, scenario instances, source objects, source changes, visibility comparison, datasets, snapshots, and admin mutation routes require admin authentication.
- Cursor payloads are schema-validated, connection-bound, and world-revision-bound.
- Production-like runtimes reject memory and SQLite storage and known development credentials.
- Emails use `@example.test`.

### Gaps

- No structured safe error envelope. Internal exceptions become `Internal simulator error`, but there is no correlation ID for operators.
- No request logging policy to prove credentials, database URLs, stack traces, and secrets are not emitted.
- No provider-failure simulation for auth failures, expired credentials, outages, or permission changes.
- No metrics for auth failures, cursor stale errors, or storage failures.
- No explicit tenant isolation beyond a single fictional tenant; the API should continue to reject client-supplied tenant/person/scope authority.

### Implementation Direction

- Add structured logs with redacted headers and no credential values.
- Add request IDs and safe error classifications.
- Add deterministic failure modes that can simulate auth failures, expired credentials, provider outages, malformed payloads, permission changes, duplicate/stale objects, cursor corruption, latency, and partial pages.
- Keep failure modes disabled by default and admin/config controlled.

## Review 3: Operations

### Verified

- `/healthz` exists but is minimal.
- SQLite local persistence supports restart recovery, snapshots, world revision, ledger, projection, metadata, and atomic world replacement.
- Startup currently validates production-like unsafe storage and credentials.
- Snapshot/restore now reconstructs instance states and ledger/projection.

### Gaps

- No Postgres adapter; production-like deployments still fail closed.
- No storage health check.
- No startup/shutdown lifecycle beyond the HTTP server process.
- No metrics endpoint.
- No request latency or storage timing visibility.
- No performance harness for small/medium/large operations.
- No backup/recovery runbook beyond snapshots.
- No build/version information in health.
- No operational docs for database migrations, credentials, failure modes, or connector test usage.

### Implementation Direction

- Implement Postgres storage with migrations, transaction-backed `replaceWorld`, restart persistence, and parity tests against SQLite.
- Improve health endpoints with uptime, storage health, world revision, dataset metadata, organization summary, build/schema version, and storage kind. Final implementation splits this into storage-independent `/healthz` liveness and storage-backed `/readyz` readiness.
- Add `/v1/admin/metrics`, `/v1/admin/performance/benchmark`, failure-mode config APIs, and a connector-kit endpoint/report.
- Add benchmark docs with local measured numbers and conditional Postgres results when a test database URL is available.

## Review 4: Workforce One Integration

### Verified

- `SourceFeedBatchV1` is stable and cursor v3 is compact.
- `nextCursor` is always returned.
- Incremental sync is append-sequence based, not offset based.
- Updates and deletes preserve stable source identity.
- Source deep links enforce the same connection visibility as feeds.
- World revision invalidates cursors after destructive resets/restores.
- Manual-trigger occurrence times are now explicit and persisted per instance.

### Gaps

- No reference connector lifecycle test kit that demonstrates initial sync, incremental sync, late arrivals, updates, deletes, world reset, stale cursor handling, new cursor acquisition, permission changes, and credential rotation.
- No documented failure-mode matrix for connector developers.
- No connector request inspector for operators.
- No performance notes for feed polling at large dataset size.

### Implementation Direction

- Add a connector test kit that can run in tests and expose admin-readable results.
- Add request inspection that records sanitized recent connector/admin requests.
- Add deterministic failure-mode controls so connector developers can test retry behavior without random faults.
- Document reset and permission-change lifecycle as the reference integration contract.

## Final Pre-Code Decision

Proceed with implementation only after this review artifact exists. Milestone 3 will focus on production hardening, not new scenario content.
