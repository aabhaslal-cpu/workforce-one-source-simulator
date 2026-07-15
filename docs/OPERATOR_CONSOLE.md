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

## Sources And Dataset

Supports:

- current dataset metadata
- deterministic dataset generation by seed and size
- source-object projection inspection
- source-change ledger inspection
- source-object history inspection
- simulator deep-link targets

The console requires the admin credential for detailed reads and writes. It does not display credential material.

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
