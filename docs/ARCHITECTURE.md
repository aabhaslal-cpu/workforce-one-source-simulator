# Architecture

## Boundary

```text
Source Simulator -> authenticated source feed -> Workforce One connector -> Workforce One evidence/provenance/reasoning
```

The simulator owns fictional source data only. Workforce One owns interpretation, ranking, recommendations, outcomes, and UI.

## Runtime Components

- `src/app.ts`: HTTP API, admin auth, connection-bound auth, request validation, operator console, source deep links, and admin inspection routes.
- `src/engine.ts`: deterministic organization-aware scenario engine, scenario instances, source-change ledger, v3 cursor feed, world revision, snapshots, dataset metadata, and visibility filtering.
- `src/adapters/*`: provider-shaped payload adapters and adapter registry.
- `src/data.ts`: fictional tenant and 10 scenario-pack definitions.
- `src/organization.ts`: role templates, deterministic people/teams/reporting graph, dotted-line relationships, cross-functional memberships, and connection IDs.
- `src/storage.ts`: storage interface, memory test adapter, and SQLite local durable adapter.
- `src/contracts.ts`: Zod runtime contract for `SourceFeedBatchV1`.

## Determinism

Stable IDs are derived from deterministic inputs: organization config, organization seed, dataset seed, dataset size, scenario pack, scenario instance, event, template, source system, and change type.

The code must not use uncontrolled `Math.random()`, `Date.now()`, random UUIDs, real people, routable emails, or real customer data.

## Change Ledger

The feed is built from a deterministic source-change ledger, not offset pagination over a mutable list.

Each ledger entry has:

- monotonic `ledgerSequence`
- `worldRevision`
- `changeId`
- `changeType`
- source system and source ID
- change time and source occurrence time
- scenario pack and scenario instance IDs
- business event and template IDs
- current source record or tombstone payload
- permission scope

The v3 cursor stores only connection ID, world revision, and `afterSequence`. It remains compact regardless of dataset size.

## Source Objects

The source-change ledger may contain future timeline mutations. The current source-object projection stores only the latest visible source object per stable source identity for the current simulation clock.

Updates and deletions preserve source identity. Deleted provider semantics are represented as tombstoned source records.

## Scenario Packs And Instances

There are 10 scenario packs. Dataset size controls deterministic instance count:

- Small: 1 instance per pack.
- Medium: 8 instances per pack.
- Large: 40 instances per pack.

Scenario instances have separate IDs and deterministic offsets, accounts, products, projects, services, and workstreams. The current implementation uses one scenario clock per pack with deterministic instance offsets.

## Organization

The simulator generates actual fictional people, not generic persona labels. Role templates are categories; generated people occupy them.

The organization includes:

- primary manager/report relationships
- dotted-line relationships
- department teams
- manager teams
- cross-functional project teams
- account teams
- launch team membership
- incident responder membership
- product, project, account, and workstream assignments

Reporting hierarchy does not grant record visibility by itself. Visibility comes from source ACLs, groups, explicit memberships, and person-specific source connections.

## Storage

SQLite local storage persists:

- `scenario_states`
- `organization_config`
- `world_state`
- `source_change_ledger`
- `source_objects`
- `dataset_metadata`
- `snapshots`

Memory storage is for tests or explicitly selected local ephemeral development. Preview, production, and Vercel-like environments reject memory and SQLite. Production Postgres remains Milestone 3 and is not claimed as ready.

## Public Vs Admin

Public catalog routes expose safe metadata only. Detailed people, organization graph, teams, source objects, source changes, assignments, relationships, and visibility comparison require admin authentication.
