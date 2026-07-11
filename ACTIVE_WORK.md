# Active Work

## Current Milestone

Milestone 3: Production Hardening and Workforce One Integration Readiness.

## Branch And Baseline

- Working branch: `milestone-3/production-hardening`.
- Baseline Milestone 2 head: `f73746113007b87530811f60f51297bff968ccf7`.
- Pre-implementation reviews were completed first and documented in `docs/MILESTONE_3_REVIEWS.md`.
- Milestone 3 must remain the final milestone and must not add new business scenario scope.

## Built In Milestone 3

- Production Postgres storage adapter behind the existing storage interface.
- Postgres support for scenario states, scenario instance states, organization config, world revision, source-change ledger, source-object projection, dataset metadata, snapshots, restart persistence, and transaction-backed world replacement.
- SQLite/Postgres parity tests and CI Postgres service.
- Structured request telemetry with sanitized logs, request IDs, connection IDs, cursor position, world revision, operation, duration, status, and safe error classification.
- Rich `/healthz` with storage health, world revision, dataset metadata, organization summary, uptime, build version, and schema version.
- Admin metrics, request inspector, storage inspector, performance benchmark, failure-mode configuration, and connector test-kit endpoints.
- Deterministic failure simulation for connector testing. Failures are configured rules, never random.
- Connector lifecycle test kit covering initial sync, incremental sync, late arrivals, updates/deletes, destructive reset, stale cursor handling, new cursor acquisition, permission differences, and connection regeneration behavior.
- Internal operator console controls for metrics, storage, ledger, snapshots, failure toggles, benchmarks, and connector kit.
- Updated OpenAPI, migrations, examples, and docs for production deployment and integration.

## Dataset Counts

Baseline deterministic datasets remain:

- Small: 131 source changes, 10 scenario instances.
- Medium: 1,048 source changes, 80 scenario instances.
- Large: 5,240 source changes, 400 scenario instances.

The benchmark harness creates one extra manual-trigger instance during each run, so benchmark count rows show 11, 81, and 401 instances.

## Latest Local Verification

- `pnpm run typecheck`: passed.
- `pnpm run test`: passed, 53 tests total with 51 local passes and 2 Postgres tests skipped without `SIMULATOR_POSTGRES_TEST_URL`.

Before final reporting, run:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

GitHub Actions provides Postgres and should run all 53 tests.

## Known Limitations

- Provider adapters are simulator-owned approximations, not complete vendor API clones.
- Postgres is proven for the simulator storage contract, but real production readiness still requires deployment-owner backups, monitoring, network policy, secret rotation, and incident response.
- Structured logs currently write sanitized JSON lines to stdout when enabled; external log shipping is an environment/deployment concern.
- The benchmark harness is a sanity benchmark, not a full load-test suite.
- The operator console is intentionally internal and utilitarian.
