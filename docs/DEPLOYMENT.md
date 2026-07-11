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
- `SIMULATOR_CLOCK_MODE`: `manual` or `realtime`. Production/Vercel should use `realtime`.
- `SIMULATOR_CLOCK_SPEED`: positive multiplier, for example `30` means one wall minute is 30 simulated minutes.
- `SIMULATOR_CONTINUOUS_ACTIVITY`: `true` keeps the fictional company producing successor activity.
- `SIMULATOR_MAX_CATCH_UP_SECONDS`: maximum wall-time catch-up applied in one reconciliation.
- `CRON_SECRET`: bearer secret required by `/api/cron/tick`.
- `SIMULATOR_FAILURE_MODES`: optional JSON failure-mode configuration.
- `SIMULATOR_RATE_LIMITS`: optional JSON real request-rate-limit configuration.
- `SIMULATOR_STRUCTURED_LOGS`: `true` emits sanitized JSON request logs.
- `SIMULATOR_POSTGRES_TEST_URL`: CI/local test-only Postgres URL for parity tests.

## Storage Schemas

The local SQLite schema is documented in `migrations/001_initial.sql` and checked against `SQLiteSimulatorStorage` in tests.

The production Postgres schema is documented in `migrations/postgres_001_initial.sql` and `migrations/postgres_002_clock_runtime.sql`, then exercised by CI when `SIMULATOR_POSTGRES_TEST_URL` is configured.

Tables:

- `scenario_states`
- `scenario_instance_states`
- `organization_config`
- `world_state`
- `source_change_ledger`
- `source_objects`
- `dataset_metadata`
- `simulation_clock_state`
- `continuous_orchestration_state`
- `snapshots`
- `rate_limit_buckets` in Postgres

## Production-Like Behavior

Preview, production, and Vercel-like environments must:

- set `SIMULATOR_ADMIN_API_KEY`
- set `SIMULATOR_CONNECTION_CREDENTIALS`
- avoid known development credentials
- avoid identical admin and connection credentials
- set `DATABASE_URL` to Postgres
- set `CRON_SECRET` before using `/api/cron/tick`
- use Postgres-backed distributed rate limits
- reject memory and SQLite, including injected storage/simulator instances

Postgres is implemented and CI-proven for the simulator storage, clock, orchestration, and distributed rate-limit contracts. Production deployment still requires external backups, secret rotation, log shipping, alerting, database patching, and network controls.

## Vercel

`src/app.ts` is the single Hono-native Vercel entrypoint. It imports the simulator factory from `src/simulator-app.ts`, creates the Hono app, and default-exports it. `src/local-server.ts` is only for local/container Node execution.

`vercel.json` uses one canonical execution model:

- frozen pnpm install
- `src/app.ts` function configuration
- bounded `maxDuration`
- explicit bundling of `migrations/*.sql`

It intentionally does not configure `buildCommand`, `outputDirectory`, `runtime`, `framework`, `rewrites`, `crons`, or an `api/index.ts` function.

Required Vercel environment variables:

- `SIMULATOR_RUNTIME_ENV=production`
- `DATABASE_URL`
- `SIMULATOR_ADMIN_API_KEY`
- `SIMULATOR_CONNECTION_CREDENTIALS`
- `SIMULATOR_PUBLIC_BASE_URL`
- `SIMULATOR_CLOCK_MODE=realtime`
- `SIMULATOR_CLOCK_SPEED`
- `SIMULATOR_CONTINUOUS_ACTIVITY=true`
- `SIMULATOR_MAX_CATCH_UP_SECONDS`
- `SIMULATOR_RATE_LIMITS`
- `CRON_SECRET`

Vercel correctness does not depend on a warm function. Feed polling and the protected `/api/cron/tick` endpoint both call the same persisted clock reconciliation path, and canonical reconciliation reads the organization config from the locked world snapshot before materializing records. Vercel does not schedule `/api/cron/tick` itself; deployment owners may wire an external scheduler if they want warm reconciliation.

When `VERCEL_TOKEN` is not available to CI, run the owner verification before marking Vercel deployment fully proven:

```bash
VERCEL_TOKEN=... pnpm run vercel:build -- --token "$VERCEL_TOKEN"
find .vercel/output -maxdepth 3 -type f | sort
```

Then smoke-test a protected preview or generated function for `/`, `/console`, `/healthz`, `/readyz`, `/v1/catalog`, `/v1/connections/{connectionId}/records`, `/sim/{sourceSystem}/{sourceId}`, and `/api/cron/tick`, including `CRON_SECRET` bearer authentication. Record the exact build or preview evidence in PR #7.

## CI

GitHub Actions runs `pnpm install --frozen-lockfile`, `pnpm run verify`, `git diff --check`, Vercel config validation, route smoke tests, Docker build, and container readiness smoke with a Postgres 16 service. The workflow sets `SIMULATOR_POSTGRES_TEST_URL`, so Postgres parity, clock persistence, distributed limiter, multi-instance organization tests, and backlog-transition rollback tests run in CI. If `VERCEL_TOKEN` is configured, CI also runs `vercel build`; otherwise the repository-owned Vercel config validation remains the always-on check and owner-run deployment verification remains required. A Vercel step that exits early because `VERCEL_TOKEN` is absent must not be recorded as an account-backed Vercel build/deployment.

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
curl -H "x-admin-api-key: $SIMULATOR_ADMIN_API_KEY" "$BASE_URL/v1/admin/clock"
curl -H "Authorization: Bearer $CRON_SECRET" "$BASE_URL/api/cron/tick"
curl -H "x-connection-secret: $PRODUCT_MANAGER_SECRET" "$BASE_URL/v1/connections/conn-product-manager/records?limit=5"
```

`/readyz` should report `storage.kind: postgres` in preview and production.
