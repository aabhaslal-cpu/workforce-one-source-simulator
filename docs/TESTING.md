# Testing

## Local Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Local verification without Postgres runs 51 tests and skips 2 Postgres tests.

## Postgres Parity

Set `SIMULATOR_POSTGRES_TEST_URL` to run Postgres tests locally:

```bash
SIMULATOR_POSTGRES_TEST_URL=postgres://postgres:postgres@localhost:5432/source_simulator_test pnpm run test
```

GitHub Actions provisions Postgres 16 and runs all 53 tests.

Postgres tests cover:

- SQLite parity for source ledger behavior
- restart persistence
- transaction rollback on injected world-replacement failure
- production-like app acceptance with Postgres storage

## Connector Test Kit

Run:

```bash
curl -X POST -H "x-admin-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{}' \
  http://localhost:3000/v1/admin/connector-test-kit/run
```

The kit covers initial sync, incremental sync, late arrivals, updates/deletes, destructive reset, stale cursor rejection, new cursor acquisition, permission differences, and connection regeneration behavior.

## Performance Sanity

Run:

```bash
curl -X POST -H "x-admin-api-key: dev-admin-key" \
  -H "content-type: application/json" \
  -d '{"storage":"sqlite","seed":"docs-benchmark","datasetSizes":["small","medium","large"]}' \
  http://localhost:3000/v1/admin/performance/benchmark
```

This is a deterministic sanity benchmark, not a full load-test suite.
