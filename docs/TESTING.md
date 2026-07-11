# Testing

## Local Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Local verification without Postgres runs 62 tests and skips 3 Postgres tests.

## Postgres Parity

Set `SIMULATOR_POSTGRES_TEST_URL` to run Postgres tests locally:

```bash
SIMULATOR_POSTGRES_TEST_URL=postgres://postgres:postgres@localhost:5432/source_simulator_test pnpm run test
```

GitHub Actions provisions Postgres 16, runs all 65 tests, validates Vercel config, smoke-tests standard routes, builds the Docker image, and runs a container `/readyz` smoke test against Postgres. If `VERCEL_TOKEN` is configured, CI also runs `vercel build`; without that token, real Vercel account build execution is intentionally skipped.

Postgres tests cover:

- SQLite parity for source ledger behavior
- restart persistence
- transaction rollback on injected world-replacement failure
- production-like app acceptance with Postgres storage
- persisted clock state across engine recreation
- Postgres-backed distributed rate limiting across app instances

## Clock And Vercel Coverage

Clock tests cover:

- manual mode preserving operator-controlled state
- realtime mode advancing by speed multiplier
- pause/resume
- SQLite restart persistence
- feed-triggered reconciliation from a saved cursor
- deterministic continuous successor creation
- idempotent duplicate reconciliation
- all-12-source activity through the major cross-functional release storyline

Vercel/deployment tests cover:

- `vercel.json` frozen install, rewrite, cron, runtime, and max-duration configuration
- `/`, `/console`, `/healthz`, `/readyz`, and `/v1/catalog`
- cron route missing, incorrect, and correct bearer secret handling
- warm-process organization refresh before connection authorization

## Connector Test Kit

Run:

```bash
curl -X POST -H "x-admin-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{}' \
  http://localhost:3000/v1/admin/connector-test-kit/run
```

The kit covers initial sync, incremental sync, late arrivals, updates/deletes, destructive reset, stale cursor rejection, new cursor acquisition, permission differences, and connection regeneration behavior.

The Vitest suite also exercises the same connector lifecycle through real HTTP routes, including invalid/revoked credentials, stale world cursor rejection, permission differences, and deterministic simulated `429`/`503` responses.

## Performance Sanity

Run:

```bash
curl -X POST -H "x-admin-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{"storage":"sqlite","seed":"docs-benchmark","datasetSizes":["small","medium","large"]}' \
  http://localhost:3000/v1/admin/performance/benchmark
```

This is a deterministic sanity benchmark, not a full load-test suite.

Postgres benchmark runs require `SIMULATOR_BENCHMARK_DATABASE_URL`. The runner rejects a benchmark URL that normalizes to the live `DATABASE_URL` and cleans up only benchmark-owned `sim_benchmark_*` schemas.
