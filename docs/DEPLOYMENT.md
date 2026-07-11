# Deployment

## Local Development

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development defaults to SQLite durable storage at `.simulator/source-simulator.sqlite`.

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
- `SIMULATOR_STORAGE_DRIVER`: `sqlite` or `memory` for development/test only.
- `SIMULATOR_SQLITE_PATH`: SQLite file path for local durable state.
- `SIMULATOR_ALLOW_EPHEMERAL_MEMORY`: must be `true` before local memory storage can be selected.
- `DATABASE_URL`: reserved for a future proven Postgres adapter.

## SQLite Schema

The local durable schema is documented in `migrations/001_initial.sql` and checked against `SQLiteSimulatorStorage` in tests.

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

The repo includes Vercel routing files, but Milestone 2 does not claim durable production deployment readiness. Preview, production, and Vercel-like environments must fail closed until Milestone 3 proves Postgres durability.
