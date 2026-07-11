# Deployment

## Local Development

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development defaults to SQLite durable storage at `.simulator/source-simulator.sqlite`.

Memory storage is allowed only when both are true:

- `SIMULATOR_STORAGE_DRIVER=memory`
- `SIMULATOR_ALLOW_EPHEMERAL_MEMORY=true`

Memory storage is never allowed in preview or production.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

## Environment Variables

- `SIMULATOR_RUNTIME_ENV`: `development`, `test`, `preview`, or `production`.
- `SIMULATOR_ADMIN_API_KEY`: admin credential. Required outside local development.
- `SIMULATOR_CONNECTION_CREDENTIALS`: JSON object mapping connection credential strings to exactly one connection ID each.
- `SIMULATOR_REVOKED_CONNECTION_CREDENTIALS`: comma-separated connection credentials to reject.
- `SIMULATOR_PUBLIC_BASE_URL`: base URL used in generated source links.
- `SIMULATOR_DEFAULT_SEED`: default deterministic seed.
- `SIMULATOR_DEFAULT_DATASET_SIZE`: `small`, `medium`, or `large`.
- `SIMULATOR_STORAGE_DRIVER`: `sqlite`, `memory`, or `postgres`.
- `SIMULATOR_SQLITE_PATH`: SQLite file path for local durable state.
- `SIMULATOR_ALLOW_EPHEMERAL_MEMORY`: must be `true` before local memory storage can be selected.
- `DATABASE_URL`: Postgres connection string. Required in preview and production.
- `SIMULATOR_BENCHMARK_DATABASE_URL`: separate Postgres connection string for benchmark runs. It must not equal `DATABASE_URL`.
- `SIMULATOR_FAILURE_MODES`: optional JSON failure-mode configuration.
- `SIMULATOR_RATE_LIMITS`: optional JSON real request-rate-limit configuration.
- `SIMULATOR_STRUCTURED_LOGS`: `true` emits sanitized JSON request logs.
- `SIMULATOR_POSTGRES_TEST_URL`: CI/local test-only Postgres URL for parity tests.

## Storage Schemas

The local SQLite schema is documented in `migrations/001_initial.sql` and checked against `SQLiteSimulatorStorage` in tests.

The production Postgres schema is documented in `migrations/postgres_001_initial.sql` and exercised by CI when `SIMULATOR_POSTGRES_TEST_URL` is configured.

Tables:

- `scenario_states`
- `scenario_instance_states`
- `organization_config`
- `world_state`
- `source_change_ledger`
- `source_objects`
- `dataset_metadata`
- `snapshots`

## Production-Like Behavior

Preview, production, and Vercel-like environments must:

- set `SIMULATOR_ADMIN_API_KEY`
- set `SIMULATOR_CONNECTION_CREDENTIALS`
- avoid known development credentials
- avoid identical admin and connection credentials
- set `DATABASE_URL` to Postgres
- reject memory and SQLite, including injected storage/simulator instances

Postgres is implemented and CI-proven for the simulator storage contract. Production deployment still requires external backups, secret rotation, log shipping, alerting, database patching, and network controls.

## CI

GitHub Actions runs `pnpm install --frozen-lockfile` and `pnpm run verify` with a Postgres 16 service. The workflow sets `SIMULATOR_POSTGRES_TEST_URL`, so Postgres parity and rollback tests run in CI. It also builds the Docker image and starts the container against the CI Postgres service, then checks `/readyz`.

## Container

The included `Dockerfile` builds the TypeScript service, installs production dependencies with frozen pnpm lockfile semantics, and runs as the non-root `node` user.

Required production container environment:

- `SIMULATOR_RUNTIME_ENV=production`
- `DATABASE_URL`
- `SIMULATOR_ADMIN_API_KEY`
- `SIMULATOR_CONNECTION_CREDENTIALS`
- `PORT` when the platform does not default to `3000`

The container `HEALTHCHECK` calls `/healthz`. Deployment readiness checks should call `/readyz`.

## Smoke Test

After deployment:

```bash
curl "$BASE_URL/healthz"
curl "$BASE_URL/readyz"
curl -H "x-admin-api-key: $SIMULATOR_ADMIN_API_KEY" "$BASE_URL/v1/admin/metrics"
curl -H "x-admin-api-key: $SIMULATOR_ADMIN_API_KEY" "$BASE_URL/v1/admin/storage"
curl -H "x-connection-secret: $PRODUCT_MANAGER_SECRET" "$BASE_URL/v1/connections/conn-product-manager/records?limit=5"
```

`/readyz` should report `storage.kind: postgres` in preview and production.
