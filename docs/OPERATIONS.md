# Operations

## Health

`GET /healthz` is unauthenticated liveness. It does not touch storage and is safe for container/process probes.

`GET /readyz` is unauthenticated readiness. It returns:

- storage health and storage kind
- world revision
- safe clock state: availability, schema version, mode, pause state, and last reconciliation status
- dataset metadata
- organization counts and validation state
- uptime
- build version and commit when provided by the environment
- contract and storage schema versions

Preview and production readiness should report `storage.kind: postgres`. If storage or world metadata is unavailable, `/readyz` returns `503` with a safe `storage_error` classification and correlation ID.

## Metrics

`GET /v1/admin/metrics` requires admin auth. It returns request counters, status counters, operation counters, latency average/max, recent sanitized request telemetry, active scenario instances, source-change count, source-object count, dataset size, organization size, ledger size, storage health, enabled failure-rule count, clock mode, clock speed, last reconciled simulation time, reconciliation count, total simulated time advanced, successor instances created, and reconciliation source-change append counters.

`GET /v1/admin/requests` returns the recent sanitized request ring buffer. It is intended for connector debugging.

## Rate Limiting

Real request rate limiting is separate from deterministic provider failure simulation. It is keyed by authenticated identity:

- admin routes: admin identity
- manifest/feed/deep-link routes: resolved connection ID
- cron route: cron identity

Rate-limit responses return `429`, `Retry-After`, a safe `rate_limit` classification, and a correlation ID. Preview and production force enabled Postgres-backed distributed buckets. Local/test environments may use in-memory buckets and may disable or override limits through `SIMULATOR_RATE_LIMITS`.

## Clock And Continuous Activity

The simulator has one persisted company clock:

- `manual`: operator-controlled scenario advance/trigger behavior is preserved.
- `realtime`: elapsed server-owned wall time advances simulation time by `speedMultiplier`.

Clock state is persisted in memory, SQLite, and Postgres. It includes wall-clock anchors, simulation anchors, last reconciliation checkpoints, speed, pause state, bounded catch-up, continuous-activity flag, and the last reconciliation report.

All realtime progress goes through `reconcileSimulationClock(now)`. Normal reconciliation does not rotate `worldRevision`; it advances eligible non-paused instances, materializes newly due creates/updates/deletes, appends ledger changes once, creates bounded deterministic successor instances when continuous activity is enabled, updates dataset metadata, and commits the clock checkpoint atomically.

Feed polling reconciles before reading `/v1/connections/{connectionId}/records`. `GET /api/cron/tick` is a Vercel-compatible warm-up path protected by `Authorization: Bearer <CRON_SECRET>`, but cron is not the source of truth. Missed cron delivery is recovered by the next cron tick or feed poll.

`POST /v1/admin/clock/reconcile`, `POST /v1/admin/clock/pause`, `POST /v1/admin/clock/resume`, `GET /v1/admin/clock`, and `PUT /v1/admin/clock` are admin-only controls. Client requests cannot set internal wall-clock checkpoints directly.

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

Postgres benchmarks require `SIMULATOR_BENCHMARK_DATABASE_URL`. The benchmark URL must not normalize to the live `DATABASE_URL`. Benchmark cleanup is limited to `sim_benchmark_*` schemas.

Measured locally on July 11, 2026 with `docs-benchmark`:

| Storage | Dataset | Generate | Advance | Trigger | Feed | Snapshot | Restore | Org Regen |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memory | small | 4.97 ms | 5.43 ms | 5.01 ms | 3.36 ms | 0.32 ms | 4.67 ms | 5.79 ms |
| memory | medium | 30.92 ms | 41.12 ms | 39.08 ms | 11.81 ms | 1.94 ms | 33.01 ms | 29.38 ms |
| memory | large | 151.97 ms | 205.48 ms | 196.19 ms | 55.02 ms | 8.70 ms | 134.29 ms | 154.50 ms |
| sqlite | small | 4.12 ms | 5.25 ms | 5.72 ms | 1.89 ms | 0.64 ms | 5.48 ms | 6.19 ms |
| sqlite | medium | 30.11 ms | 42.85 ms | 42.61 ms | 8.74 ms | 1.94 ms | 38.30 ms | 40.79 ms |
| sqlite | large | 160.21 ms | 231.39 ms | 218.81 ms | 37.37 ms | 7.83 ms | 191.81 ms | 197.34 ms |

Postgres benchmark numbers should be captured in a benchmark database, not against the live application database.
