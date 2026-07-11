# Deployment

## Local

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development defaults to SQLite durable storage at `.simulator/source-simulator.sqlite`.

## Verification

```bash
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
- `SIMULATOR_STORAGE_DRIVER`: `sqlite` or `memory`.
- `SIMULATOR_SQLITE_PATH`: SQLite file path for local durable state.
- `SIMULATOR_ALLOW_EPHEMERAL_MEMORY`: must be `true` before local memory storage can be selected.
- `DATABASE_URL`: reserved for future production durable adapters.

## Local Development Credentials

```bash
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/catalog/people
curl -H 'x-connection-secret: dev-connection-secret:conn-product-manager' \
  'http://localhost:3000/v1/connections/conn-product-manager/records?limit=5'
```

The development connection credential is still bound to one connection ID. There is no universal development connection secret.

## Production-Like Fail Closed Rules

Preview, Vercel-like, and production runtimes refuse to start when:

- `SIMULATOR_ADMIN_API_KEY` is missing.
- `SIMULATOR_CONNECTION_CREDENTIALS` is missing or empty.
- A known development admin or connection credential is configured.
- An admin credential and connection credential are identical.
- Memory storage is selected.
- Durable storage is unavailable.

## Vercel

The repo includes `vercel.json` and `api/index.ts`, but this milestone does not claim durable Vercel deployment readiness. Without a proven production durable adapter, Vercel-like environments should fail closed rather than fall back to process memory.

## Migrations

Migration files live under `migrations/`. They document the durable schema shape expected for future production storage adapters. SQLite local persistence is implemented in `src/storage.ts` for scenario states, organization configuration, and snapshots.
