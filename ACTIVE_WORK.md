# Active Work

## Current Milestone

Milestone 3: Production Hardening and Workforce One Integration Readiness.

## Branch And Baseline

- Working branch: `milestone-3/production-hardening`.
- Baseline Milestone 2 head: `f73746113007b87530811f60f51297bff968ccf7`.
- Pre-implementation reviews were completed first and documented in `docs/MILESTONE_3_REVIEWS.md`.
- Milestone 3 must remain the final milestone and must not add new business scenario scope.

## Built In Milestone 3

- Production Postgres storage adapter behind the async storage interface.
- Postgres support for scenario states, scenario instance states, organization config, world revision, source-change ledger, source-object projection, dataset metadata, snapshots, simulation clock, continuous orchestration state, restart persistence, and transaction-backed world replacement.
- SQLite/Postgres parity tests and CI Postgres service.
- Persisted company clock with manual/realtime modes, bounded catch-up, speed multiplier, pause/resume, restart persistence, feed-triggered reconciliation, admin reconciliation, and a protected cron-compatible tick endpoint.
- Fail-closed clock transition guard: time-affecting clock/orchestration updates are rejected with `clock_backlog_conflict` while bounded realtime catch-up still has wall-clock backlog, and the evaluation reconciliation rolls back with the rejected transaction.
- Deterministic continuous activity orchestrator that creates bounded successor instances from the existing 10 scenario packs while preserving one shared company world and preserving manual-event semantics.
- Structured request telemetry with sanitized logs, request IDs, connection IDs, cursor position, world revision, operation, duration, status, and safe error classification.
- `/healthz` liveness and `/readyz` readiness with storage health, world revision, dataset metadata, organization summary, uptime, build version, and schema version.
- Admin metrics, request inspector, storage inspector, performance benchmark, failure-mode configuration, and connector test-kit endpoints.
- Real request rate limiting keyed by authenticated admin identity, cron identity, or resolved connection ID. Preview/production use Postgres-backed distributed buckets.
- Deterministic failure simulation for connector testing. Failures are configured rules, never random.
- Connector lifecycle test kit covering initial sync, incremental sync, late arrivals, updates/deletes, destructive reset, stale cursor handling, new cursor acquisition, permission differences, and connection regeneration behavior.
- Vercel configuration with one canonical Hono entrypoint at `src/app.ts`, bounded max duration, explicit migration SQL bundling, frozen install, config validation, optional token-backed Vercel CLI build, and CI route smoke tests.
- Container build and CI readiness smoke test against Postgres.
- Internal operator console controls for clock, metrics, storage, ledger, snapshots, failure toggles, benchmarks, and connector kit.
- Updated OpenAPI, migrations, examples, and docs for production deployment and integration.

## Dataset Counts

Baseline deterministic datasets remain:

- Small: 131 source changes, 10 scenario instances.
- Medium: 1,048 source changes, 80 scenario instances.
- Large: 5,240 source changes, 400 scenario instances.

The benchmark harness creates one extra manual-trigger instance during each run, so benchmark count rows show 11, 81, and 401 instances.

## Latest Local Verification

- `pnpm install --frozen-lockfile`: passed.
- `pnpm run verify`: passed.
- `pnpm run vercel:validate`: passed.
- `git diff --check`: passed.
- Vitest count: 79 tests total with 73 local passes and 6 Postgres tests skipped without `SIMULATOR_POSTGRES_TEST_URL`.
- Real local `pnpm run vercel:build`: attempted and failed because Vercel CLI reported an invalid cached/account token; no `.vercel/output` was produced locally.

GitHub Actions provides Postgres and should run all 79 tests, Vercel config validation, route smoke tests, Docker build, and container readiness smoke. A real Vercel CLI build runs only when `VERCEL_TOKEN` is configured; when it exits early because `VERCEL_TOKEN` is absent, that step is not deployment proof.

## Known Limitations

- Provider adapters are simulator-owned approximations, not complete vendor API clones.
- Postgres is proven for the simulator storage, clock, orchestration, and distributed rate-limit contracts, but real production readiness still requires deployment-owner backups, monitoring, network policy, secret rotation, and incident response.
- Structured logs currently write sanitized JSON lines to stdout when enabled; external log shipping is an environment/deployment concern.
- The benchmark harness is a sanity benchmark, not a full load-test suite.
- The operator console is intentionally internal and utilitarian.
