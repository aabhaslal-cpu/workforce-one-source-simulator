# Deployment

## Local

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

## Verification

```bash
pnpm run verify
```

## Environment Variables

- `DATABASE_URL`: reserved for durable storage adapters.
- `SIMULATOR_ADMIN_API_KEY`: admin credential.
- `SIMULATOR_CONNECTION_SECRET`: connector credential.
- `SIMULATOR_PUBLIC_BASE_URL`: base URL used in generated source links.
- `SIMULATOR_DEFAULT_SEED`: default deterministic seed.
- `SIMULATOR_DEFAULT_DATASET_SIZE`: `small`, `medium`, or `large`.

## Vercel

The repo includes `vercel.json` and `api/index.ts`. Milestone 3 should perform deployment verification, production env setup, and runbook capture.

## Migrations

Migration files live under `migrations/`. They document the durable schema shape expected for Postgres/SQLite adapters.
