# Storage

## Adapters

The simulator keeps one storage interface with three implementations:

- `memory`: tests and explicitly selected local ephemeral development only.
- `sqlite`: local durable development and restart-persistence testing.
- `postgres`: preview and production storage.

Preview, production, and Vercel-like environments reject memory and SQLite even when injected through `AppOptions.storage` or `AppOptions.simulator`.

## Durable State

All durable adapters store:

- legacy `scenario_states`
- `scenario_instance_states`
- `organization_config`
- `world_state`
- `source_change_ledger`
- `source_objects`
- `dataset_metadata`
- `snapshots`

Scenario packs are code templates. Scenario instances are persisted runtime state.

## Transactions

World replacement commits the scenario instance states, world revision, source-change ledger, source-object projection, dataset metadata, and organization config when applicable as one unit.

SQLite uses one database transaction. Postgres uses one database transaction through the Postgres worker adapter.

Rollback tests inject a failure during world replacement and assert the previous world remains intact.

## Migrations

- SQLite: `migrations/001_initial.sql`
- Postgres: `migrations/postgres_001_initial.sql`

The runtime adapters create the same schema if it does not exist. Tests verify SQLite migration drift and Postgres durable table coverage.

## Postgres Adapter

The Postgres adapter uses `pg.Pool` inside a worker-thread bridge so the existing synchronous engine/storage interface remains stable. This avoids an API-breaking async storage rewrite in Milestone 3.

The adapter supports restart persistence, source ledger persistence, source-object projection persistence, snapshots, health checks, and atomic world replacement.

## Cursor Impact

Normal advance and manual trigger append source changes without rotating world revision. Existing cursors remain valid.

Scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore destructively rebuild the world and rotate world revision. Existing cursors become stale and must be discarded by connectors.
