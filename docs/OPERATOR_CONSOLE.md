# Operator Console

The operator console is available at `/console`.

It is an internal simulator control panel, not a Workforce One screen and not a public demo.

## Organization

Supports:

- organization tree
- department filter
- role-level filter
- person search
- person detail
- person visible records
- two-person visibility comparison
- organization regeneration by seed
- organization reset

API responses distinguish primary reporting, dotted-line relationships, project/account membership, source groups, work ownership, and permission access.

## Scenarios

Supports:

- all 11 scenario pack options
- scenario state
- reset
- advance time
- event log
- scenario pack list
- scenario instance list
- scenario instance detail
- independent instance advance/reset/trigger/pause/resume

The scenario dropdown is an inspection and mutation lens for a selected pack or instance. It is not the
feed switch. Dataset generation and normal connector feeds operate over the whole simulator world.

## Sources And Dataset

Supports:

- current dataset metadata
- all-scenario flow summary proving every pack is loaded and which connections can see scenario data
- deterministic dataset generation by seed and size
- source-object projection inspection
- source-change ledger inspection
- source-object history inspection
- simulator deep-link targets

The console requires the simulator project's `SIMULATOR_ADMIN_API_KEY` for detailed reads and writes.
The local-development fallback is `dev-admin-key`; production deployments do not use that default. The
admin key only unlocks operator inspection. Workforce One ingestion uses connection credentials, so
changing the admin key does not change which source records flow through connector feeds.

## Clock

Supports:

- current clock mode
- current simulated time through the persisted clock state
- last reconciled wall time
- speed multiplier
- pause/running state
- continuous activity state
- last reconciliation report
- active and completed scenario instance counts
- recent successor instances
- recent appended source changes
- switch manual/realtime mode
- set bounded speed multiplier
- select continuous activity profile
- set maximum successors per reconciliation
- set minimum successor interval hours
- pause/resume global clock
- reconcile now
- enable/disable continuous activity

## Operations

Supports:

- health inspection
- live metrics
- recent sanitized request inspection
- storage inspection
- ledger inspection
- snapshot browsing
- deterministic failure-mode configuration and reset
- benchmark execution
- connector test-kit execution

The console is intentionally utilitarian. It is for simulator operators and connector developers, not end users.
