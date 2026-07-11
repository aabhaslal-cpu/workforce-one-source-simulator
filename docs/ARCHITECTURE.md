# Architecture

## Shape

```text
Source Simulator
  -> authenticated incremental source feed
  -> Workforce One connector
  -> connector-ingress gateway
  -> evidence and provenance
  -> Workforce One product reasoning and UI
```

The simulator owns fictional source data only. Workforce One owns interpretation.

## Runtime Components

- `src/app.ts`: HTTP API, auth boundaries, operator console.
- `src/engine.ts`: deterministic scenario engine, records, cursors, snapshots, organization-aware visibility.
- `src/domain.ts`: shared domain types.
- `src/organization.ts`: deterministic organization generator, role templates, reporting tree, and person-level connections.
- `src/data.ts`: fictional tenant and M1 scenario templates.
- `src/contracts.ts`: SourceFeedBatchV1 Zod schemas.
- `src/storage.ts`: storage interface and in-memory implementation.

## Determinism

Record identity is derived from seed, organization seed, scenario, event, source system, object type, and template ID. The same seed, organization configuration, scenario state, and trigger sequence produce the same organization and records. Different seeds produce different stable people and source IDs while preserving valid structure.

## Organization

The simulator generates actual people, not only persona labels. Role templates define categories such as Product Manager or VP Customer Success; generated people occupy those templates. Each person has a manager, direct reports, team, source identities, work ownership, permission groups, and person-level source connection.

## State

Scenario state includes:

- scenario ID
- seed
- dataset size
- start time
- current time
- paused flag
- triggered event IDs
- debugging event log

Organization state includes:

- organization seed
- organization configuration
- generated people
- teams
- reporting relationships
- validation result

The event log is for operator inspection only and is not part of the Workforce One data contract.

## Permissions

Connections map server-side to a concrete generated person, allowed source systems, and allowed groups. Clients cannot choose arbitrary tenant, department, person, or group scope. Reporting hierarchy does not automatically grant visibility; ACLs and source memberships do.

## Storage

Milestone 1 uses an in-process storage interface so the engine is not coupled to a database. Migration files document the intended durable shape. Milestone 3 should complete deployment-grade Postgres verification and can pull SQLite local durability forward if needed.
