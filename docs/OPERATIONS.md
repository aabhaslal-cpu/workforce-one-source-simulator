# Operations

## Health

`GET /healthz` is unauthenticated and safe for deployment probes. It returns:

- storage health and storage kind
- world revision
- dataset metadata
- organization counts and validation state
- uptime
- build version and commit when provided by the environment
- contract and storage schema versions

Preview and production health should report `storage.kind: postgres`.

## Metrics

`GET /v1/admin/metrics` requires admin auth. It returns request counters, status counters, operation counters, latency average/max, recent sanitized request telemetry, active scenario instances, source-change count, source-object count, dataset size, organization size, ledger size, storage health, and enabled failure-rule count.

`GET /v1/admin/requests` returns the recent sanitized request ring buffer. It is intended for connector debugging.

## Logs

Set `SIMULATOR_STRUCTURED_LOGS=true` to emit one JSON line per request.

Logs include request ID, method, path, operation, status, duration, connection ID when present, world revision, cursor version, cursor position, and safe error classification.

Logs never include credentials, request bodies, stack traces, or database connection strings.

## Storage Inspection

`GET /v1/admin/storage` reports storage health, dataset metadata, world revision, scenario instance count, snapshot count, source-change count, and source-object count.

## Recovery

Use snapshots for deterministic simulator recovery:

1. Create a snapshot with `POST /v1/admin/snapshots`.
2. Restore with `POST /v1/admin/snapshots/{snapshotId}/restore`.
3. Restore rotates world revision and invalidates old cursors.
4. The ledger and source-object projection are atomically reconstructed from restored scenario instance states.

Database-level backups remain a deployment responsibility.

## Benchmarks

`POST /v1/admin/performance/benchmark` runs deterministic benchmark operations for memory, SQLite, or Postgres. The endpoint creates its own benchmark world and does not mutate the active service world.

Measured locally on July 11, 2026 with `docs-benchmark`:

| Storage | Dataset | Generate | Advance | Trigger | Feed | Snapshot | Restore | Org Regen |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | small | 4.97 ms | 5.43 ms | 5.01 ms | 3.36 ms | 0.32 ms | 4.67 ms | 5.79 ms |
| memory | medium | 30.92 ms | 41.12 ms | 39.08 ms | 11.81 ms | 1.94 ms | 33.01 ms | 29.38 ms |
| memory | large | 151.97 ms | 205.48 ms | 196.19 ms | 55.02 ms | 8.70 ms | 134.29 ms | 154.50 ms |
| sqlite | small | 4.12 ms | 5.25 ms | 5.72 ms | 1.89 ms | 0.64 ms | 5.48 ms | 6.19 ms |
| sqlite | medium | 30.11 ms | 42.85 ms | 42.61 ms | 8.74 ms | 1.94 ms | 38.30 ms | 40.79 ms |
| sqlite | large | 160.21 ms | 231.39 ms | 218.81 ms | 37.37 ms | 7.83 ms | 191.81 ms | 197.34 ms |

Postgres benchmarks require `DATABASE_URL` and should be captured in the target deployment environment.
